import type { FastifyInstance } from "fastify";
import { idempotencyKeyFor } from "../test-support/idempotency-keys.js";
import { describe, expect, it, vi } from "vitest";

import {
  bearer,
  exportBody,
  TEST_API_KEY,
  TEST_URL,
  validRecipe,
} from "../test-support/fixtures.js";
import { buildServer } from "./server.js";

const REQUEST_ID = /^req_[0-9A-HJKMNP-TV-Z]{26}$/;

function app(): FastifyInstance {
  return buildServer({
    apiKey: TEST_API_KEY,
    extractRecipe: (async () => validRecipe) as never,
    exportRecipe: (async () => ({ name: validRecipe.title, identifier: "id-1" })) as never,
    importRecipe: (async () => ({
      recipe: validRecipe,
      saved: { name: validRecipe.title, identifier: "id-1" },
    })) as never,
  });
}

const AUTH = { authorization: bearer(), "content-type": "application/json" };

describe("X-Request-Id", () => {
  it.each([
    ["health", { method: "GET" as const, url: "/health", headers: {} }, 200],
    ["unknown route", { method: "GET" as const, url: "/nope", headers: {} }, 404],
    [
      "401",
      { method: "POST" as const, url: "/api/imports", headers: { "content-type": "application/json" } },
      401,
    ],
    [
      "400",
      { method: "POST" as const, url: "/api/imports", headers: AUTH, payload: { nope: 1 } },
      400,
    ],
    [
      "409",
      {
        method: "POST" as const,
        url: "/api/exports/anylist",
        // A valid key, so this case still exercises the recipe rejection it
        // was written for rather than being short-circuited by key validation.
        headers: { ...AUTH, "idempotency-key": "3f7b1e40-9c2d-4a68-b1f5-7e0a6c48d213" },
        payload: { schemaVersion: 1, recipe: { ...validRecipe, title: "  " } },
      },
      400,
    ],
    ["legacy 200", { method: "POST" as const, url: "/api/import", headers: AUTH, payload: { url: TEST_URL } }, 200],
    [
      "production 200",
      { method: "POST" as const, url: "/api/imports", headers: AUTH, payload: { schemaVersion: 1, url: TEST_URL } },
      200,
    ],
  ])("is present on %s", async (_label, request, status) => {
    const response = await app().inject(request as never);

    expect(response.statusCode).toBe(status);
    expect(response.headers["x-request-id"]).toMatch(REQUEST_ID);
  });

  it("matches the envelope value on production routes", async () => {
    const response = await app().inject({
      method: "POST",
      url: "/api/imports",
      headers: AUTH,
      payload: { schemaVersion: 1, url: TEST_URL },
    });

    expect(response.headers["x-request-id"]).toBe(response.json().requestId);
  });

  it("adopts a safe client value end to end", async () => {
    const response = await app().inject({
      method: "POST",
      url: "/api/imports",
      headers: { ...AUTH, "x-request-id": "shortcut-run-9" },
      payload: { schemaVersion: 1, url: TEST_URL },
    });

    expect(response.headers["x-request-id"]).toBe("shortcut-run-9");
    expect(response.json().requestId).toBe("shortcut-run-9");
  });

  it("replaces an unsafe client value instead of failing the request", async () => {
    const response = await app().inject({
      method: "POST",
      url: "/api/imports",
      headers: { ...AUTH, "x-request-id": "../../etc/passwd" },
      payload: { schemaVersion: 1, url: TEST_URL },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toMatch(REQUEST_ID);
  });
});

describe("413 Request body too large", () => {
  it("is returned rather than a 500, on the 8 KB routes", async () => {
    const response = await app().inject({
      method: "POST",
      url: "/api/imports",
      headers: AUTH,
      payload: { schemaVersion: 1, url: TEST_URL, pad: "x".repeat(9 * 1024) },
    });

    expect(response.statusCode).toBe(413);
    expect(response.json().error).toBe("Request body too large");
  });

  it("applies the larger limit to the export route", async () => {
    // A 20 KB recipe is far past the 8 KB server default and comfortably inside
    // the export route's own 64 KB allowance.
    const wordy = {
      ...validRecipe,
      instructions: [`Step: ${"x".repeat(20 * 1024)}`],
    };

    const response = await app().inject({
      method: "POST",
      url: "/api/exports/anylist",
      headers: { ...AUTH, "idempotency-key": idempotencyKeyFor("k1") },
      payload: exportBody(wordy as never),
    });

    expect(response.statusCode).toBe(200);
  });

  it("still rejects a body past the export limit", async () => {
    const enormous = {
      ...validRecipe,
      instructions: [`Step: ${"x".repeat(70 * 1024)}`],
    };

    const response = await app().inject({
      method: "POST",
      url: "/api/exports/anylist",
      headers: { ...AUTH, "idempotency-key": idempotencyKeyFor("k2") },
      payload: exportBody(enormous as never),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json().error).toBe("Request body too large");
  });
});

describe("415 Unsupported content type", () => {
  it.each(["text/plain", "application/xml", "application/x-www-form-urlencoded"])(
    "rejects %s",
    async (contentType) => {
      const response = await app().inject({
        method: "POST",
        url: "/api/imports",
        headers: { authorization: bearer(), "content-type": contentType },
        payload: "url=whatever",
      });

      expect(response.statusCode).toBe(415);
      expect(response.json().error).toBe("Unsupported content type");
    },
  );

  it("accepts application/json with a charset", async () => {
    const response = await app().inject({
      method: "POST",
      url: "/api/imports",
      headers: { authorization: bearer(), "content-type": "application/json; charset=utf-8" },
      payload: JSON.stringify({ schemaVersion: 1, url: TEST_URL }),
    });

    expect(response.statusCode).toBe(200);
  });

  it("rejects malformed JSON as a bad body, not a 500", async () => {
    const response = await app().inject({
      method: "POST",
      url: "/api/imports",
      headers: AUTH,
      payload: "{ not json",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("Invalid request body");
  });
});

describe("authentication is deny-by-default", () => {
  it("protects a route registered under an unrelated prefix", async () => {
    const server = buildServer({ apiKey: TEST_API_KEY });
    server.get("/internal/metrics", async () => ({ secret: true }));

    const response = await server.inject({ method: "GET", url: "/internal/metrics" });

    // A prefix check would have left this public purely because of where
    // someone chose to mount it.
    expect(response.statusCode).toBe(401);
  });

  it("keeps /health public", async () => {
    const response = await app().inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("still answers 404 for an unknown route rather than 401", async () => {
    // Part 1 freezes this. Leaking route existence is the lesser concern here,
    // and changing it would be an unapproved contract change.
    const response = await app().inject({ method: "GET", url: "/nope" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ success: false, error: "Not found" });
  });
});

describe("URL validation happens before expensive work", () => {
  it("never calls extraction for an unparseable URL", async () => {
    const extractRecipe = vi.fn(async () => validRecipe);
    const server = buildServer({ apiKey: TEST_API_KEY, extractRecipe: extractRecipe as never });

    const response = await server.inject({
      method: "POST",
      url: "/api/imports",
      headers: AUTH,
      payload: { schemaVersion: 1, url: "javascript:alert(1)" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("Invalid recipe URL");
    expect(extractRecipe).not.toHaveBeenCalled();
  });

  it.each(["file:///etc/passwd", "data:text/html,<script>", "ftp://example.com/x"])(
    "rejects %s at the boundary",
    async (url) => {
      const extractRecipe = vi.fn(async () => validRecipe);
      const server = buildServer({ apiKey: TEST_API_KEY, extractRecipe: extractRecipe as never });

      const response = await server.inject({
        method: "POST",
        url: "/api/imports",
        headers: AUTH,
        payload: { schemaVersion: 1, url },
      });

      expect(response.statusCode).toBe(400);
      expect(extractRecipe).not.toHaveBeenCalled();
    },
  );
});
