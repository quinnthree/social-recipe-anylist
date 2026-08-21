import type { FastifyInstance, InjectOptions } from "fastify";
import { describe, expect, it } from "vitest";

import { AnyListError } from "../anylist/types.js";
import { ExportError } from "../app/export-service.js";
import { ImportError } from "../app/import-service.js";
import { exportBody, recipeWith, TEST_URL, validRecipe } from "../test-support/fixtures.js";
import { buildServer } from "./server.js";

/**
 * Values that must never appear in a response body or a log line, anywhere,
 * on any path.
 *
 * Distinctive strings rather than realistic ones, so a match is unambiguous
 * evidence of a leak rather than a coincidence.
 */
const API_KEY = "RECIPE-KEY-zzq7Xk92";
const ANYLIST_PASSWORD = "ANYLIST-PW-vv41Qm";
const ANTHROPIC_KEY = "sk-ant-LEAK-93hd8";
const ANYLIST_TOKEN = "ANYLIST-TOKEN-ff02Nb";
const IDEMPOTENCY_KEY = "IDEMPOTENCY-KEY-uu83Zt";

const SECRETS = [API_KEY, ANYLIST_PASSWORD, ANTHROPIC_KEY, ANYLIST_TOKEN, IDEMPOTENCY_KEY];

/**
 * A provider error of the shape the AnyList research workstream observed:
 * credentials and session material reachable through the object graph.
 */
function leakyProviderError(): Error {
  const error = new Error(
    `POST /auth failed for user with password ${ANYLIST_PASSWORD} (key ${ANTHROPIC_KEY})`,
  );
  Object.assign(error, {
    response: {
      statusCode: 401,
      headers: { "set-cookie": `session=${ANYLIST_TOKEN}; HttpOnly` },
    },
    password: ANYLIST_PASSWORD,
    accessToken: ANYLIST_TOKEN,
    apiKey: ANTHROPIC_KEY,
  });

  return error;
}

interface Case {
  name: string;
  request: InjectOptions;
  deps?: Parameters<typeof buildServer>[0];
}

const AUTH = {
  authorization: `Bearer ${API_KEY}`,
  "content-type": "application/json",
  "idempotency-key": IDEMPOTENCY_KEY,
};

function importsRequest(payload: unknown): InjectOptions {
  return { method: "POST", url: "/api/imports", headers: AUTH, payload: payload as never };
}

function exportRequest(payload: unknown): InjectOptions {
  return { method: "POST", url: "/api/exports/anylist", headers: AUTH, payload: payload as never };
}

const CASES: Case[] = [
  {
    name: "unauthenticated",
    request: {
      method: "POST",
      url: "/api/imports",
      headers: { authorization: `Bearer wrong-${API_KEY}`, "content-type": "application/json" },
      payload: { schemaVersion: 1, url: TEST_URL },
    },
  },
  { name: "unknown route", request: { method: "GET", url: "/nope" } },
  { name: "health", request: { method: "GET", url: "/health" } },
  { name: "bad body", request: importsRequest({ nope: true }) },
  { name: "unsupported schema version", request: importsRequest({ schemaVersion: 7, url: TEST_URL }) },
  { name: "bad url", request: importsRequest({ schemaVersion: 1, url: "javascript:alert(1)" }) },
  {
    name: "oversized body",
    request: importsRequest({ schemaVersion: 1, url: TEST_URL, pad: "x".repeat(9 * 1024) }),
  },
  {
    name: "wrong content type",
    request: {
      method: "POST",
      url: "/api/imports",
      headers: { authorization: `Bearer ${API_KEY}`, "content-type": "text/plain" },
      payload: "hello",
    },
  },
  {
    name: "extraction failure carrying a provider error",
    request: importsRequest({ schemaVersion: 1, url: TEST_URL }),
    deps: {
      apiKey: API_KEY,
      extractRecipe: (async () => {
        throw new ImportError(leakyProviderError().message, "extraction_failed");
      }) as never,
    },
  },
  {
    name: "unexpected extraction throw",
    request: importsRequest({ schemaVersion: 1, url: TEST_URL }),
    deps: {
      apiKey: API_KEY,
      extractRecipe: (async () => {
        throw leakyProviderError();
      }) as never,
    },
  },
  { name: "invalid recipe", request: exportRequest(exportBody(recipeWith({ title: "  " }))) },
  { name: "missing idempotency key", request: { ...exportRequest(exportBody()), headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" } } },
  {
    name: "export failure carrying an AnyList error",
    request: exportRequest(exportBody()),
    deps: {
      apiKey: API_KEY,
      exportRecipe: (async () => {
        throw new AnyListError(leakyProviderError().message, "login_failed");
      }) as never,
    },
  },
  {
    name: "ambiguous export",
    request: exportRequest(exportBody()),
    deps: {
      apiKey: API_KEY,
      exportRecipe: (async () => {
        throw new ExportError(leakyProviderError().message, "AMBIGUOUS", "create_failed");
      }) as never,
    },
  },
  {
    name: "unexpected export throw",
    request: exportRequest(exportBody()),
    deps: {
      apiKey: API_KEY,
      exportRecipe: (async () => {
        throw leakyProviderError();
      }) as never,
    },
  },
  {
    name: "legacy import failure",
    request: {
      method: "POST",
      url: "/api/import",
      headers: AUTH,
      payload: { url: TEST_URL },
    },
    deps: {
      apiKey: API_KEY,
      importRecipe: (async () => {
        throw new ImportError(leakyProviderError().message, "save_failed");
      }) as never,
    },
  },
  {
    name: "successful export",
    request: exportRequest(exportBody()),
    deps: {
      apiKey: API_KEY,
      exportRecipe: (async () => ({ name: validRecipe.title, identifier: "id-1" })) as never,
    },
  },
];

function build(deps: Parameters<typeof buildServer>[0] | undefined): {
  app: FastifyInstance;
  written: () => string;
} {
  let output = "";

  const app = buildServer({
    apiKey: API_KEY,
    extractRecipe: (async () => validRecipe) as never,
    exportRecipe: (async () => ({ name: validRecipe.title, identifier: "id-1" })) as never,
    importRecipe: (async () => ({
      recipe: validRecipe,
      saved: { name: validRecipe.title, identifier: "id-1" },
    })) as never,
    ...deps,
    logger: true,
    logDestination: {
      write(chunk: string) {
        output += chunk;
      },
    },
  });

  return { app, written: () => output };
}

describe("secret and log redaction", () => {
  it.each(CASES.map((testCase) => [testCase.name, testCase] as const))(
    "leaks nothing on: %s",
    async (_name, testCase) => {
      const { app, written } = build(testCase.deps);

      const response = await app.inject(testCase.request);

      for (const secret of SECRETS) {
        expect(response.body).not.toContain(secret);
        expect(written()).not.toContain(secret);
      }

      // The header itself, not just the token inside it.
      expect(written()).not.toContain("Bearer");
      expect(written()).not.toContain("set-cookie");
    },
  );

  it.each(CASES.map((testCase) => [testCase.name, testCase] as const))(
    "returns only a fixed error string on: %s",
    async (_name, testCase) => {
      const { app } = build(testCase.deps);

      const response = await app.inject(testCase.request);
      if (response.statusCode < 400) return;

      const body = response.json() as { error?: unknown };

      // Every failure string is chosen by us and selected by kind. Nothing from
      // an underlying error is ever echoed.
      expect(typeof body.error).toBe("string");
      expect(body.error).not.toContain("password");
      expect(body.error).not.toContain("Error:");
      expect(body.error).not.toMatch(/\s(at|stack)\s/);
    },
  );

  it("does not log the caption or the recipe body", async () => {
    const caption = "SECRET-CAPTION-TEXT-that-should-never-be-logged";
    const { app, written } = build({
      apiKey: API_KEY,
      extractRecipe: (async (_url: string, options: { onSourceContent?: (c: unknown) => void }) => {
        options.onSourceContent?.({
          platform: "tiktok",
          url: TEST_URL,
          creator: "creator",
          text: caption,
          textSource: "caption",
        });
        return validRecipe;
      }) as never,
    });

    await app.inject(importsRequest({ schemaVersion: 1, url: TEST_URL }));

    expect(written()).not.toContain(caption);
    expect(written()).not.toContain("cottage cheese");
    expect(written()).not.toContain("Blend until smooth");
    // The title is explicitly acceptable, and already logged today.
    expect(written()).toContain(validRecipe.title);
  });

  it("does not log the raw Idempotency-Key even though it is in the headers", async () => {
    const { app, written } = build({
      apiKey: API_KEY,
      exportRecipe: (async () => ({ name: validRecipe.title, identifier: "id-1" })) as never,
    });

    await app.inject(exportRequest(exportBody()));

    expect(written()).not.toContain(IDEMPOTENCY_KEY);
    // It is still usable: the log records only whether one was present.
    expect(written()).toContain("idempotencyKeyPresent");
  });

  it("logs a failure kind rather than the error that produced it", async () => {
    const { app, written } = build({
      apiKey: API_KEY,
      exportRecipe: (async () => {
        throw new ExportError(leakyProviderError().message, "AMBIGUOUS", "create_failed");
      }) as never,
    });

    await app.inject(exportRequest(exportBody()));

    expect(written()).toContain("create_failed");
    expect(written()).not.toContain("POST /auth failed");
  });
});
