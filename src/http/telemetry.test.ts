import { readFileSync } from "node:fs";
import { idempotencyKeyFor } from "../test-support/idempotency-keys.js";

import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { ExportError } from "../app/export-service.js";
import { ImportError } from "../app/import-service.js";
import {
  bearer,
  exportBody,
  sourceContent,
  TEST_API_KEY,
  TEST_URL,
  validRecipe,
} from "../test-support/fixtures.js";
import { buildServer } from "./server.js";
import { EXTRACTION_MODEL, type ImportTelemetry } from "./telemetry.js";

interface Captured {
  app: FastifyInstance;
  lines: Record<string, unknown>[];
}

/**
 * Captures the JSON lines pino would actually write.
 *
 * Asserting against real output rather than a spy is the point: redaction
 * happens inside pino's serialiser, so a mock would prove nothing about what
 * reaches the platform's logs.
 */
function capturing(overrides: Parameters<typeof buildServer>[0]): Captured {
  const lines: Record<string, unknown>[] = [];
  let pending = "";

  const app = buildServer({
    ...overrides,
    logger: true,
    logDestination: {
      write(chunk: string) {
        pending += chunk;
        const parts = pending.split("\n");
        pending = parts.pop() ?? "";
        for (const part of parts) {
          if (part.trim().length > 0) lines.push(JSON.parse(part) as Record<string, unknown>);
        }
      },
    },
  });

  return { app, lines };
}

function telemetryFrom(lines: Record<string, unknown>[]): ImportTelemetry[] {
  return lines.filter((line) => line["event"] === "import.telemetry") as unknown as ImportTelemetry[];
}

const AUTH = { authorization: bearer(), "content-type": "application/json" };

describe("ImportTelemetry", () => {
  it("emits exactly one event per request", async () => {
    const { app, lines } = capturing({
      apiKey: TEST_API_KEY,
      extractRecipe: (async () => validRecipe) as never,
    });

    await app.inject({
      method: "POST",
      url: "/api/imports",
      headers: AUTH,
      payload: { schemaVersion: 1, url: TEST_URL },
    });

    expect(telemetryFrom(lines)).toHaveLength(1);
  });

  it("carries the current-pipeline fields on a successful extraction", async () => {
    const { app, lines } = capturing({
      apiKey: TEST_API_KEY,
      extractRecipe: (async (_url: string, options: { onSourceContent?: (c: unknown) => void }) => {
        options.onSourceContent?.(sourceContent);
        return validRecipe;
      }) as never,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/imports",
      headers: AUTH,
      payload: { schemaVersion: 1, url: TEST_URL },
    });

    const event = telemetryFrom(lines)[0]!;

    expect(event).toMatchObject({
      event: "import.telemetry",
      requestId: response.json().requestId,
      route: "/api/imports",
      status: 200,
      sourcePlatform: "tiktok",
      sourceType: "caption",
      captionLength: sourceContent.text.length,
      modelUsed: EXTRACTION_MODEL,
      confidence: validRecipe.confidence,
      warningCount: validRecipe.warnings.length,
      savedToAnyList: false,
      failed: false,
      failureStage: null,
    });
    expect(typeof event.processingTimeMs).toBe("number");
    expect(typeof event.extractionMs).toBe("number");
  });

  it("leaves token counts null rather than inventing them", async () => {
    const { app, lines } = capturing({
      apiKey: TEST_API_KEY,
      extractRecipe: (async () => validRecipe) as never,
    });

    await app.inject({
      method: "POST",
      url: "/api/imports",
      headers: AUTH,
      payload: { schemaVersion: 1, url: TEST_URL },
    });

    // parseRecipe() does not expose Anthropic usage, and parser contracts are
    // not being changed to serve telemetry.
    expect(telemetryFrom(lines)[0]).toMatchObject({ inputTokens: null, outputTokens: null });
  });

  it("records the export phase, including the idempotency state", async () => {
    const { app, lines } = capturing({
      apiKey: TEST_API_KEY,
      exportRecipe: (async () => ({ name: validRecipe.title, identifier: "id-1" })) as never,
    });

    await app.inject({
      method: "POST",
      url: "/api/exports/anylist",
      headers: { ...AUTH, "idempotency-key": idempotencyKeyFor("k1") },
      payload: exportBody(),
    });

    expect(telemetryFrom(lines)[0]).toMatchObject({
      route: "/api/exports/anylist",
      status: 200,
      savedToAnyList: true,
      idempotent: false,
      idempotencyState: "COMPLETED",
      failed: false,
    });
  });

  it("marks a replay", async () => {
    const { app, lines } = capturing({
      apiKey: TEST_API_KEY,
      exportRecipe: (async () => ({ name: validRecipe.title, identifier: "id-1" })) as never,
    });

    const send = () =>
      app.inject({
        method: "POST",
        url: "/api/exports/anylist",
        headers: { ...AUTH, "idempotency-key": idempotencyKeyFor("k1") },
        payload: exportBody(),
      });

    await send();
    await send();

    expect(telemetryFrom(lines)[1]).toMatchObject({ idempotent: true, savedToAnyList: true });
  });

  it("records an auth failure, which is the one worth watching", async () => {
    const { app, lines } = capturing({
      apiKey: TEST_API_KEY,
      extractRecipe: (async () => validRecipe) as never,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/imports",
      headers: { "content-type": "application/json" },
      payload: { schemaVersion: 1, url: TEST_URL },
    });

    expect(response.statusCode).toBe(401);
    // Started in the auth hook rather than the handler, so a rejected request
    // still leaves exactly one trace.
    expect(telemetryFrom(lines)[0]).toMatchObject({
      route: "/api/imports",
      status: 401,
      failed: true,
      failureStage: "auth",
      failureKind: "unauthorized",
    });
  });

  it("records a validation failure against the validation stage", async () => {
    const { app, lines } = capturing({
      apiKey: TEST_API_KEY,
      extractRecipe: (async () => validRecipe) as never,
    });

    await app.inject({
      method: "POST",
      url: "/api/imports",
      headers: AUTH,
      payload: { schemaVersion: 1 },
    });

    expect(telemetryFrom(lines)[0]).toMatchObject({
      failed: true,
      failureStage: "validation",
      failureKind: "invalid_body",
    });
  });

  it("names the verification stage when read-back is what failed", async () => {
    const { app, lines } = capturing({
      apiKey: TEST_API_KEY,
      exportRecipe: (async () => {
        throw new ExportError("could not read back", "AMBIGUOUS", "verify_unreadable");
      }) as never,
    });

    await app.inject({
      method: "POST",
      url: "/api/exports/anylist",
      headers: { ...AUTH, "idempotency-key": idempotencyKeyFor("k1") },
      payload: exportBody(),
    });

    expect(telemetryFrom(lines)[0]).toMatchObject({
      failed: true,
      failureStage: "verification",
      failureKind: "verify_unreadable",
      idempotencyState: "AMBIGUOUS",
      savedToAnyList: false,
    });
  });

  it("names the deadline stage on a timeout", async () => {
    const { app, lines } = capturing({
      apiKey: TEST_API_KEY,
      exportRecipe: (async () => {
        throw new ExportError("timed out", "AMBIGUOUS", "export_timeout");
      }) as never,
    });

    await app.inject({
      method: "POST",
      url: "/api/exports/anylist",
      headers: { ...AUTH, "idempotency-key": idempotencyKeyFor("k1") },
      payload: exportBody(),
    });

    expect(telemetryFrom(lines)[0]).toMatchObject({ failureStage: "deadline" });
  });

  it("records extraction failures against the extraction stage", async () => {
    const { app, lines } = capturing({
      apiKey: TEST_API_KEY,
      extractRecipe: (async () => {
        throw new ImportError("nothing usable", "extraction_failed");
      }) as never,
    });

    await app.inject({
      method: "POST",
      url: "/api/imports",
      headers: AUTH,
      payload: { schemaVersion: 1, url: TEST_URL },
    });

    expect(telemetryFrom(lines)[0]).toMatchObject({
      status: 422,
      failed: true,
      failureStage: "extraction",
      failureKind: "extraction_failed",
    });
  });

  it("carries no caption, recipe body, or ingredient text", async () => {
    const { app, lines } = capturing({
      apiKey: TEST_API_KEY,
      extractRecipe: (async (_url: string, options: { onSourceContent?: (c: unknown) => void }) => {
        options.onSourceContent?.(sourceContent);
        return validRecipe;
      }) as never,
    });

    await app.inject({
      method: "POST",
      url: "/api/imports",
      headers: AUTH,
      payload: { schemaVersion: 1, url: TEST_URL },
    });

    const serialised = JSON.stringify(telemetryFrom(lines)[0]);

    expect(serialised).not.toContain(sourceContent.text);
    expect(serialised).not.toContain("cottage cheese");
    expect(serialised).not.toContain("Blend until smooth");
    expect(serialised).not.toContain(validRecipe.warnings[0]);
  });

  it("emits nothing for /health", async () => {
    const { app, lines } = capturing({ apiKey: TEST_API_KEY });

    await app.inject({ method: "GET", url: "/health" });

    expect(telemetryFrom(lines)).toHaveLength(0);
  });
});

describe("EXTRACTION_MODEL", () => {
  it("matches the model the parser actually uses", () => {
    // src/recipe/parser.ts owns the value and does not export it, and it belongs
    // to another workstream. Pinning it here turns a model change into a failing
    // assertion rather than telemetry that quietly reports the wrong model.
    const parser = readFileSync("src/recipe/parser.ts", "utf8");
    const declared = /const MODEL = "([^"]+)"/.exec(parser)?.[1];

    expect(declared).toBe(EXTRACTION_MODEL);
  });
});
