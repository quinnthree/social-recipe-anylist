import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { z } from "zod";

import { exportRecipe } from "../app/export-service.js";
import {
  extractRecipe,
  ImportError,
  importRecipe,
  type ImportFailureKind,
} from "../app/import-service.js";
import type { ClientCredentialStore } from "../client/store.js";
import { MemoryIdempotencyStore } from "../idempotency/memory-store.js";
import { DEFAULT_LEASE_MS, type IdempotencyStore } from "../idempotency/store.js";
import type { RouteContext } from "./context.js";
import { failLegacy, failWith, FAILURES, kindForFastifyCode, type FailureKind } from "./errors.js";
import { resolvePrincipal } from "./principal.js";
import { resolveRequestId } from "./request-id.js";
import { registerExportRoute } from "./routes/exports-anylist.js";
import { registerImportsRoute } from "./routes/imports.js";
import { newDraft, STAGE_BY_KIND, telemetryRouteFor, toTelemetry } from "./telemetry.js";

/** One URL is all the legacy endpoint accepts, so the body stays tiny. */
const BODY_LIMIT_BYTES = 8 * 1024;

const ImportRequestSchema = z.object({ url: z.string().url() }).strict();

/** Fixed, safe response text. Nothing from an underlying error is ever echoed. */
const LEGACY_FAILURES: Record<ImportFailureKind, { status: number; error: string }> = {
  invalid_url: { status: 400, error: "Invalid recipe URL" },
  unsupported_platform: { status: 400, error: "Unsupported platform" },
  extraction_failed: { status: 422, error: "Recipe could not be extracted" },
  save_failed: { status: 500, error: "Recipe import failed" },
  internal: { status: 500, error: "Recipe import failed" },
};

/**
 * The only unauthenticated path.
 *
 * An allowlist rather than a `/api/` prefix check, so authentication is
 * deny-by-default: a route added tomorrow cannot end up public because of where
 * someone chose to mount it.
 */
const PUBLIC_PATHS: ReadonlySet<string> = new Set(["/health"]);

/**
 * Routes whose envelopes carry `requestId`.
 *
 * `POST /api/import` keeps its Part 1 envelope byte-for-byte — it is frozen
 * convenience behaviour that the CLI and regression tests depend on. It still
 * receives the `X-Request-Id` header, which is additive and cannot break a
 * client that does not read it.
 */
const PRODUCTION_ROUTES = ["/api/imports", "/api/exports/anylist"];

export interface ServerDeps {
  /** Required. buildServer throws if this is missing or empty. */
  apiKey: string | undefined;
  /** Injectable so route tests never touch TikTok, Anthropic, or AnyList. */
  importRecipe?: typeof importRecipe;
  extractRecipe?: typeof extractRecipe;
  exportRecipe?: typeof exportRecipe;
  /**
   * Durable idempotency for the export route. Defaults to an in-process store,
   * which is acceptable for tests and local development and **never** for a
   * deployment — see `src/server.ts`, which refuses to start without a real one.
   */
  idempotencyStore?: IdempotencyStore;
  /**
   * Consumer credentials (ADR-026). Absent means this deployment does not offer
   * installation authentication, and a well-formed installation token is
   * refused rather than accepted — never the other way round.
   *
   * Requests carrying `RECIPE_API_KEY` never reach it.
   */
  clientStore?: ClientCredentialStore | undefined;
  now?: () => number;
  leaseMs?: number;
  logger?: boolean;
  /**
   * Where log lines go. Injectable so tests can assert on the JSON that would
   * really be written — redaction is only worth anything if it is checked
   * against actual output rather than against a mock.
   */
  logDestination?: { write(chunk: string): void };
}

export function buildServer({
  apiKey,
  importRecipe: runImport = importRecipe,
  extractRecipe: runExtract = extractRecipe,
  exportRecipe: runExport = exportRecipe,
  idempotencyStore = new MemoryIdempotencyStore(),
  clientStore,
  now = Date.now,
  leaseMs = DEFAULT_LEASE_MS,
  logger = false,
  logDestination,
}: ServerDeps): FastifyInstance {
  if (apiKey === undefined || apiKey.trim().length === 0) {
    // Refusing to start beats silently serving an unauthenticated import endpoint.
    throw new Error("RECIPE_API_KEY is not set. Refusing to start an unauthenticated API.");
  }

  const server = Fastify({
    bodyLimit: BODY_LIMIT_BYTES,
    // The request id is the public one, so every log line carries it without a
    // second identifier to keep in sync.
    genReqId: (request) => resolveRequestId(request.headers["x-request-id"]).requestId,
    logger: logger && {
      // Structural, so these cannot be logged even by a future handler.
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.headers['x-api-key']",
          "req.headers['idempotency-key']",
          "*.password",
          "*.token",
          "*.accessToken",
          "*.refreshToken",
          "*.apiKey",
        ],
        remove: true,
      },
      ...(logDestination === undefined ? {} : { stream: logDestination }),
    },
  });

  // Fastify parses text/plain by default, which would turn "wrong content
  // type" into a confusing 400 about the body instead of an honest 415.
  server.removeContentTypeParser("text/plain");

  const context: RouteContext = {
    extractRecipe: runExtract,
    exportRecipe: runExport,
    importRecipe: runImport,
    idempotencyStore,
    now,
    leaseMs,
  };

  // Every response, with no exceptions: successes, 401s, 404s, 413s, and
  // anything the error handler produces.
  server.addHook("onSend", async (request, reply) => {
    reply.header("X-Request-Id", request.id);
  });

  server.addHook("onRequest", async (request, reply) => {
    request.requestIdSource =
      request.headers["x-request-id"] === request.id ? "client" : "generated";

    // Deny by default over *registered* routes. An unmatched path is left to
    // the not-found handler, so an unknown route still answers `404 Not found`
    // as Part 1 freezes it, rather than 401.
    const route = request.routeOptions.url;
    if (route === undefined) return;

    if (PUBLIC_PATHS.has(route)) return;

    // Started here rather than in the handler, so a rejected request still
    // produces exactly one telemetry event. Without this, 401s — the ones worth
    // watching — would be the only requests that left no trace.
    const telemetryRoute = telemetryRouteFor(route);
    if (telemetryRoute !== null) request.telemetry = newDraft(telemetryRoute);

    const resolution = await resolvePrincipal({
      header: request.headers.authorization,
      internalSecret: apiKey,
      clientStore,
      now: now(),
    });

    if (resolution.outcome === "authenticated") {
      const { principal } = resolution;
      request.principal = principal;

      if (request.telemetry !== undefined) {
        request.telemetry.principalKind = principal.kind;
        request.telemetry.clientId = principal.kind === "installation" ? principal.clientId : null;
      }

      request.log.info(
        {
          event: "request.received",
          route,
          method: request.method,
          requestIdSource: request.requestIdSource,
          idempotencyKeyPresent: request.headers["idempotency-key"] !== undefined,
          principalKind: principal.kind,
          // Public by design. The token, the secret, and the digest are not,
          // and none of them are in scope here.
          ...(principal.kind === "installation" ? { clientId: principal.clientId } : {}),
        },
        "request received",
      );
      return;
    }

    // A store that could not answer is our failure, not a bad credential.
    // Answering 401 would tell every consumer client to discard a working
    // credential and register again — an outage would then destroy the
    // credentials and stampede registration at the same time.
    const kind: FailureKind = resolution.outcome === "unavailable" ? "import_failed" : "unauthorized";

    if (request.telemetry !== undefined) {
      request.telemetry.failureKind = kind;
      request.telemetry.failureStage = STAGE_BY_KIND[kind];
    }

    await respond(route, reply, kind, request.id);
  });

  // Exactly one telemetry event per request that reached a production or legacy
  // route. Emitted from a hook rather than from each exit path, so no early
  // return can silently skip it.
  server.addHook("onResponse", async (request, reply) => {
    const draft = request.telemetry;
    if (draft === undefined) return;

    request.log.info(toTelemetry(draft, request.id, reply.statusCode), "request completed");
  });

  // Unauthenticated. Proves the process is alive and nothing else — no
  // Anthropic, TikTok, Instagram, or AnyList calls.
  server.get("/health", async () => ({ status: "ok" }));

  registerImportsRoute(server, context);
  registerExportRoute(server, context);

  /**
   * The original one-shot endpoint. Kept for the CLI and internal use, and
   * deliberately unchanged: same body schema, same envelope, same statuses.
   *
   * It is no longer exempt from the minimum usable recipe, because that gate
   * now lives at the shared import-service boundary rather than in a route
   * (ADR-019, QA-003) — this is the path that actually writes to AnyList, so it
   * was the wrong one to hold to a weaker standard.
   */
  server.post("/api/import", async (request, reply) => {
    const draft = request.telemetry ?? newDraft("/api/import");
    request.telemetry = draft;

    const body = ImportRequestSchema.safeParse(request.body);
    if (!body.success) {
      draft.failureKind = "invalid_body";
      draft.failureStage = "validation";
      await failLegacy(reply, 400, "Invalid request body");
      return;
    }

    const startedAt = process.hrtime.bigint();

    try {
      const { recipe, saved } = await runImport(body.data.url, {
        onSourceContent: (content) => {
          draft.sourceType = content.textSource;
          draft.captionLength = content.text.length;
        },
      });

      draft.sourcePlatform = recipe.source.platform;
      draft.confidence = recipe.confidence;
      draft.warningCount = recipe.warnings.length;
      draft.savedToAnyList = saved !== null;

      request.log.info(
        {
          event: "import.completed",
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
      const { status, error: message } = LEGACY_FAILURES[kind];

      draft.failureKind = kind;
      draft.failureStage = kind === "save_failed" ? "export" : STAGE_BY_KIND["extraction_failed"];

      // Log the kind, never the error object: it can carry provider detail.
      request.log.warn(
        { event: "import.failed", outcome: "failure", kind, status, elapsedMs: elapsedMsSince(startedAt) },
        "recipe import failed",
      );

      await failLegacy(reply, status, message);
      return;
    }
  });

  /**
   * Guarantees the same envelope for unexpected throws, and gives 413 and 415
   * their own answers instead of collapsing them into a 500 that tells a client
   * nothing about what it sent.
   */
  server.setErrorHandler(async (error: unknown, request, reply) => {
    const statusCode = readStatusCode(error);
    const kind = kindForFastifyCode(readCode(error), statusCode);

    request.log.error({ event: "request.error", statusCode, failureKind: kind }, "unhandled request error");

    if (request.telemetry !== undefined) {
      request.telemetry.failureKind = kind;
      request.telemetry.failureStage = STAGE_BY_KIND[kind];
    }

    await respond(request.routeOptions.url, reply, kind, request.id);
  });

  server.setNotFoundHandler(async (request, reply) => {
    await respond(undefined, reply, "not_found", request.id);
  });

  return server;
}

/**
 * Production routes carry `requestId` in the envelope; Part 1 routes do not.
 *
 * A catch-all failure on the export route reports "Recipe export failed"
 * rather than "Recipe import failed", so the message names the operation the
 * client actually asked for.
 */
async function respond(
  route: string | undefined,
  reply: FastifyReply,
  kind: FailureKind,
  requestId: string,
): Promise<void> {
  const resolved: FailureKind =
    kind === "import_failed" && route === "/api/exports/anylist" ? "export_failed" : kind;

  if (route !== undefined && PRODUCTION_ROUTES.includes(route)) {
    await failWith(reply, resolved, requestId);
    return;
  }

  const { status, error } = FAILURES[resolved];
  await failLegacy(reply, status, error);
}

/** Reads a status off an unknown error without touching its message or stack. */
function readStatusCode(error: unknown): number {
  if (typeof error !== "object" || error === null) return 500;

  const { statusCode } = error as { statusCode?: unknown };
  return typeof statusCode === "number" ? statusCode : 500;
}

function readCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return undefined;

  return (error as { code?: unknown }).code;
}

function elapsedMsSince(startedAt: bigint): number {
  return Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
}
