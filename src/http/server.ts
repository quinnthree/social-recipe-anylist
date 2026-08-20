import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { z } from "zod";

import { importRecipe, ImportError, type ImportFailureKind } from "../app/import-service.js";
import { isAuthorized } from "./auth.js";

/** One URL is all this endpoint accepts, so the body stays tiny. */
const BODY_LIMIT_BYTES = 8 * 1024;

const ImportRequestSchema = z.object({ url: z.string().url() }).strict();

/** Fixed, safe response text. Nothing from an underlying error is ever echoed. */
const FAILURE_RESPONSES: Record<ImportFailureKind, { status: number; error: string }> = {
  invalid_url: { status: 400, error: "Invalid recipe URL" },
  unsupported_platform: { status: 400, error: "Unsupported platform" },
  extraction_failed: { status: 422, error: "Recipe could not be extracted" },
  save_failed: { status: 500, error: "Recipe import failed" },
  internal: { status: 500, error: "Recipe import failed" },
};

export interface ServerDeps {
  /** Required. buildServer throws if this is missing or empty. */
  apiKey: string | undefined;
  /** Injectable so route tests never touch TikTok, Anthropic, or AnyList. */
  importRecipe?: typeof importRecipe;
  logger?: boolean;
}

export function buildServer({
  apiKey,
  importRecipe: runImport = importRecipe,
  logger = false,
}: ServerDeps): FastifyInstance {
  if (apiKey === undefined || apiKey.trim().length === 0) {
    // Refusing to start beats silently serving an unauthenticated import endpoint.
    throw new Error("RECIPE_API_KEY is not set. Refusing to start an unauthenticated API.");
  }

  const server = Fastify({
    bodyLimit: BODY_LIMIT_BYTES,
    logger: logger && {
      // Structural, so the token cannot be logged even by a future handler.
      redact: { paths: ["req.headers.authorization"], remove: true },
    },
  });

  // Unauthenticated. Proves the process is alive and nothing else — no
  // Anthropic, TikTok, Instagram, or AnyList calls.
  server.get("/health", async () => ({ status: "ok" }));

  // Scoped to /api, so any future route under it is protected by default.
  server.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    if (isAuthorized(request.headers.authorization, apiKey)) return;

    await fail(reply, 401, "Unauthorized");
  });

  server.post("/api/import", async (request, reply) => {
    const body = ImportRequestSchema.safeParse(request.body);
    if (!body.success) {
      await fail(reply, 400, "Invalid request body");
      return;
    }

    const startedAt = process.hrtime.bigint();

    try {
      const { recipe, saved } = await runImport(body.data.url);

      request.log.info(
        {
          platform: recipe.source.platform,
          outcome: "success",
          title: recipe.title,
          confidence: recipe.confidence,
          elapsedMs: elapsedMsSince(startedAt),
        },
        "recipe imported",
      );

      return {
        success: true,
        recipe: {
          title: recipe.title,
          confidence: recipe.confidence,
          warnings: recipe.warnings,
        },
        saved: { id: saved?.identifier ?? null },
      };
    } catch (error) {
      const kind: ImportFailureKind = error instanceof ImportError ? error.kind : "internal";
      const { status, error: message } = FAILURE_RESPONSES[kind];

      // Log the kind, never the error object: it can carry provider detail.
      request.log.warn(
        { outcome: "failure", kind, status, elapsedMs: elapsedMsSince(startedAt) },
        "recipe import failed",
      );

      await fail(reply, status, message);
      return;
    }
  });

  // Guarantees the same envelope for unexpected throws and unknown routes, so
  // Fastify's default bodies (which include messages) never reach a client.
  server.setErrorHandler(async (error: unknown, request, reply) => {
    const statusCode = readStatusCode(error);
    request.log.error({ statusCode }, "unhandled request error");
    await fail(reply, statusCode === 400 ? 400 : 500, safeTextFor(statusCode));
  });

  server.setNotFoundHandler(async (_request, reply) => {
    await fail(reply, 404, "Not found");
  });

  return server;
}

/** Reads a status off an unknown error without touching its message or stack. */
function readStatusCode(error: unknown): number {
  if (typeof error !== "object" || error === null) return 500;

  const { statusCode } = error as { statusCode?: unknown };
  return typeof statusCode === "number" ? statusCode : 500;
}

function safeTextFor(statusCode: number): string {
  return statusCode === 400 ? "Invalid request body" : "Recipe import failed";
}

async function fail(reply: FastifyReply, status: number, error: string): Promise<void> {
  await reply.code(status).send({ success: false, error });
}

function elapsedMsSince(startedAt: bigint): number {
  return Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
}
