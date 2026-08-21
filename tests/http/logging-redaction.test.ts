import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

import { ImportError, type ImportResult } from "../../src/app/import-service.js";
import { buildServer } from "../../src/http/server.js";
import { SECRETS } from "../support/planted-secrets.js";

/**
 * Objective 7: prove that nothing which must stay secret reaches a response or
 * a log line.
 *
 * Two layers, because they fail differently:
 *  - responses, asserted in-process across every failure path;
 *  - the real pino output, captured from a child process, because buildServer
 *    takes `logger: boolean` and gives a test no way to attach a stream.
 */

const run = promisify(execFile);

const ALL_SECRETS = Object.values(SECRETS);

async function captureLogs(): Promise<string> {
  const { stdout } = await run("node_modules/.bin/tsx", ["tests/support/log-capture.child.ts"]);
  return stdout;
}

describe("production log output", () => {
  it("emits parseable structured lines for the requests it handled", async () => {
    const stdout = await captureLogs();
    const lines = stdout.split("\n").filter((line) => line.trim().length > 0);

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
  }, 30_000);

  it.each(Object.entries(SECRETS))("never writes the %s to a log line", async (_name, secret) => {
    const stdout = await captureLogs();

    expect(stdout).not.toContain(secret);
  }, 30_000);

  it("never writes an Authorization header value, valid or invalid", async () => {
    const stdout = await captureLogs();

    expect(stdout.toLowerCase()).not.toContain("bearer ");
    expect(stdout).not.toContain(SECRETS.apiKey);
  }, 30_000);

  it("logs the failure kind and status, never the underlying error", async () => {
    // A failure must be diagnosable from the log without the provider message
    // ever being written. `kind` and `status` are the whole diagnostic surface.
    const stdout = await captureLogs();

    expect(stdout).toContain("recipe import failed");
    expect(stdout).toContain("save_failed");
    expect(stdout).not.toContain("AnyList login failed");
    expect(stdout).not.toContain("planted-cook@example.com");
  }, 30_000);

  it("logs the recipe title on success but not the recipe contents", async () => {
    // contracts.md: "Recipe title on success is acceptable and already logged
    // today", full recipe contents are not.
    const stdout = await captureLogs();

    expect(stdout).toContain("Cottage Cheese Brownies");
    expect(stdout).not.toContain("cottage cheese");
    expect(stdout).not.toContain("Blend until smooth");
    expect(stdout).not.toContain("rawText");
  }, 30_000);

  it("writes no stack traces", async () => {
    const stdout = await captureLogs();

    expect(stdout).not.toContain("at Object.");
    expect(stdout).not.toContain(".test.ts:");
  }, 30_000);
});

describe("responses never carry a secret, on any path", () => {
  const API_KEY = SECRETS.apiKey;
  const url = "https://www.tiktok.com/@proteinbakes/video/7311111111111111111";

  const leakyMessage =
    `AnyList login failed for ${SECRETS.anylistEmail} with password ${SECRETS.anylistPassword}; ` +
    `anthropic key ${SECRETS.anthropicKey}; token ${SECRETS.anylistToken}`;

  function serverThatFailsWith(error: unknown) {
    return buildServer({
      apiKey: API_KEY,
      importRecipe: vi.fn(async (): Promise<ImportResult> => {
        throw error;
      }),
    });
  }

  const failures = [
    ["invalid_url", new ImportError(leakyMessage, "invalid_url")],
    ["unsupported_platform", new ImportError(leakyMessage, "unsupported_platform")],
    ["extraction_failed", new ImportError(leakyMessage, "extraction_failed")],
    ["save_failed", new ImportError(leakyMessage, "save_failed")],
    ["internal", new ImportError(leakyMessage, "internal")],
    ["an unexpected throw", new Error(leakyMessage)],
    ["a thrown string", leakyMessage],
    ["a thrown object", { message: leakyMessage, response: { body: SECRETS.anylistToken } }],
  ] as const;

  it.each(failures)("returns nothing secret for %s", async (_label, error) => {
    const app = serverThatFailsWith(error);
    const response = await app.inject({
      method: "POST",
      url: "/api/import",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { url },
    });

    for (const secret of ALL_SECRETS) {
      expect(response.body).not.toContain(secret);
    }
    expect(response.body).not.toContain("password");
    expect(response.body).not.toContain("Bearer");
    expect(response.json().success).toBe(false);
  });

  it("returns nothing secret when the token itself is wrong", async () => {
    const app = serverThatFailsWith(new Error(leakyMessage));
    const response = await app.inject({
      method: "POST",
      url: "/api/import",
      headers: { authorization: `Bearer ${SECRETS.anthropicKey}` },
      payload: { url },
    });

    expect(response.statusCode).toBe(401);
    for (const secret of ALL_SECRETS) {
      expect(response.body).not.toContain(secret);
    }
  });

  it("does not echo a submitted URL back in an error", async () => {
    // A URL can carry a share token or a session identifier in its query string.
    const app = serverThatFailsWith(new ImportError("x", "extraction_failed"));
    const tracked = "https://www.tiktok.com/@a/video/1?share_token=SECRET-SHARE-TOKEN";
    const response = await app.inject({
      method: "POST",
      url: "/api/import",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { url: tracked },
    });

    expect(response.body).not.toContain("SECRET-SHARE-TOKEN");
  });

  it("returns a fixed string, so error text cannot vary with the input", async () => {
    const app = serverThatFailsWith(new ImportError(leakyMessage, "extraction_failed"));
    const first = await app.inject({
      method: "POST",
      url: "/api/import",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { url },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/import",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { url: "https://www.instagram.com/reel/Cxyz123/" },
    });

    expect(first.body).toBe(second.body);
    expect(first.json()).toEqual({ success: false, error: "Recipe could not be extracted" });
  });
});
