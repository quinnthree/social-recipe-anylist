import { describe, expect, it, vi } from "vitest";

import { fixture } from "../../fixtures/corpus.js";
import { requireRecipe } from "../../fixtures/types.js";
import type { ImportResult } from "../../src/app/import-service.js";
import { buildServer } from "../../src/http/server.js";
import { RecipeSchema } from "../../src/recipe/schema.js";
import { gap } from "./contract-gaps.js";

/**
 * POST /api/imports — extraction only. Proposed in contracts.md Part 2 and
 * NOT IMPLEMENTED.
 *
 * Two halves:
 *
 *  1. Active tests that assert the endpoint does not exist yet. These are the
 *     tripwire: the moment the route is added they fail, which forces whoever
 *     added it to unskip the specification below rather than ship untested.
 *  2. A skipped specification of the contract, written out in full so it can be
 *     enabled in one edit.
 *
 * Nothing here is invented. Every assertion traces to contracts.md Part 2 §A,
 * "Schema versioning", "Request IDs", or "Error envelope". Where the contract
 * does not say, the test says so instead of guessing — see the
 * CONTRACT GAP tests.
 */

const API_KEY = "test-api-key-2f8c1d";
const AUTH = { authorization: `Bearer ${API_KEY}` };

const golden = fixture("tiktok-cottage-cheese-brownies");
const recipe = requireRecipe(golden);

const result: ImportResult = {
  recipe,
  saved: { name: recipe.title, identifier: "anylist-recipe-id-42" },
};

function server(importRecipe = vi.fn(async (): Promise<ImportResult> => result)) {
  return { app: buildServer({ apiKey: API_KEY, importRecipe }), importRecipe };
}

const validBody = { schemaVersion: 1, url: golden.url };

describe("POST /api/imports — not implemented today", () => {
  it("is not routed", async () => {
    const { app } = server();
    const response = await app.inject({
      method: "POST",
      url: "/api/imports",
      headers: AUTH,
      payload: validBody,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ success: false, error: "Not found" });
  });

  it("is still behind authentication even though it does not exist", async () => {
    const { app } = server();
    const response = await app.inject({ method: "POST", url: "/api/imports", payload: validBody });

    expect(response.statusCode).toBe(401);
  });

  it("does not run the pipeline", async () => {
    const { app, importRecipe } = server();
    await app.inject({ method: "POST", url: "/api/imports", headers: AUTH, payload: validBody });

    expect(importRecipe).not.toHaveBeenCalled();
  });
});

/**
 * ENABLE THIS BLOCK when POST /api/imports lands. Change `describe.skip` to
 * `describe` and delete the "not implemented today" block above.
 *
 * The Backend agent will need an injectable extraction dependency on
 * ServerDeps, the way `importRecipe` is injectable now, so these can run
 * without touching TikTok or Anthropic. Designing that seam is the backend's
 * call; this suite only requires that one exists.
 */
describe.skip("POST /api/imports — specification (contracts.md Part 2 §A)", () => {
  describe("authentication", () => {
    it("rejects a missing or wrong bearer token with the standard envelope", async () => {
      const { app } = server();

      const missing = await app.inject({ method: "POST", url: "/api/imports", payload: validBody });
      const wrong = await app.inject({
        method: "POST",
        url: "/api/imports",
        headers: { authorization: "Bearer wrong" },
        payload: validBody,
      });

      expect(missing.statusCode).toBe(401);
      expect(wrong.statusCode).toBe(401);
      expect(missing.json().error).toBe("Unauthorized");
    });
  });

  describe("schemaVersion", () => {
    it("accepts schemaVersion 1 and echoes it on success", async () => {
      const { app } = server();
      const response = await app.inject({ method: "POST", url: "/api/imports", headers: AUTH, payload: validBody });

      expect(response.statusCode).toBe(200);
      expect(response.json().schemaVersion).toBe(1);
    });

    it.each([
      ["missing", { url: golden.url }],
      ["null", { schemaVersion: null, url: golden.url }],
      ["a string", { schemaVersion: "1", url: golden.url }],
      ["non-integer", { schemaVersion: 1.5, url: golden.url }],
    ])("rejects a %s schemaVersion with 400 Invalid request body", async (_label, payload) => {
      const { app } = server();
      const response = await app.inject({ method: "POST", url: "/api/imports", headers: AUTH, payload });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("Invalid request body");
    });

    it("rejects a recognised-but-unsupported version distinctly", async () => {
      const { app } = server();
      const response = await app.inject({
        method: "POST",
        url: "/api/imports",
        headers: AUTH,
        payload: { schemaVersion: 2, url: golden.url },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("Unsupported schema version");
    });
  });

  describe("strict body validation", () => {
    it("rejects an unknown key rather than ignoring it", async () => {
      // ADR-011: "unknown keys are rejected, not ignored". A client must never
      // be able to believe the server honoured a field it silently dropped.
      const { app } = server();
      const response = await app.inject({
        method: "POST",
        url: "/api/imports",
        headers: AUTH,
        payload: { ...validBody, dryRun: true },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("Invalid request body");
    });

    it.each([
      ["a missing url", { schemaVersion: 1 }],
      ["a non-string url", { schemaVersion: 1, url: 42 }],
      ["a malformed url", { schemaVersion: 1, url: "not a url" }],
    ])("rejects %s", async (_label, payload) => {
      const { app } = server();
      const response = await app.inject({ method: "POST", url: "/api/imports", headers: AUTH, payload });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("extraction only", () => {
    it("returns the complete canonical Recipe, not the summary /api/import returns", async () => {
      const { app } = server();
      const response = await app.inject({ method: "POST", url: "/api/imports", headers: AUTH, payload: validBody });
      const body = response.json();

      expect(RecipeSchema.safeParse(body.recipe).success).toBe(true);
      expect(body.recipe).toEqual(recipe);
    });

    it("returns every field the review screen needs", async () => {
      const { app } = server();
      const body = (await app.inject({ method: "POST", url: "/api/imports", headers: AUTH, payload: validBody })).json();

      expect(Object.keys(body.recipe).sort()).toEqual([
        "confidence",
        "cookTime",
        "description",
        "ingredients",
        "instructions",
        "prepTime",
        "servings",
        "source",
        "title",
        "warnings",
      ]);
    });

    it("writes nothing to AnyList", async () => {
      // The whole reason the endpoint exists (ADR-007): Review/Edit happens
      // before anything is committed.
      const { app } = server();
      const body = (await app.inject({ method: "POST", url: "/api/imports", headers: AUTH, payload: validBody })).json();

      expect(body.saved).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("anylist-recipe-id");
    });

    it("preserves source provenance exactly as extracted", async () => {
      const { app } = server();
      const body = (await app.inject({ method: "POST", url: "/api/imports", headers: AUTH, payload: validBody })).json();

      expect(body.recipe.source).toEqual({
        platform: "tiktok",
        creator: golden.expectedSourceContent?.creator,
        url: golden.url,
      });
    });
  });

  describe("request IDs", () => {
    it("returns a requestId in the body and the X-Request-Id header, and they match", async () => {
      const { app } = server();
      const response = await app.inject({ method: "POST", url: "/api/imports", headers: AUTH, payload: validBody });

      const requestId = response.json().requestId;
      expect(typeof requestId).toBe("string");
      expect(response.headers["x-request-id"]).toBe(requestId);
    });

    it("adopts a client-supplied X-Request-Id rather than generating one", async () => {
      const { app } = server();
      const response = await app.inject({
        method: "POST",
        url: "/api/imports",
        headers: { ...AUTH, "x-request-id": "shortcut-run-42" },
        payload: validBody,
      });

      expect(response.json().requestId).toBe("shortcut-run-42");
      expect(response.headers["x-request-id"]).toBe("shortcut-run-42");
    });

    it("returns a requestId on failures too", async () => {
      const { app } = server();
      const response = await app.inject({
        method: "POST",
        url: "/api/imports",
        headers: AUTH,
        payload: { schemaVersion: 1, url: "not a url" },
      });

      expect(typeof response.json().requestId).toBe("string");
      expect(response.headers["x-request-id"]).toBe(response.json().requestId);
    });
  });

  describe("safe failures", () => {
    it.each([
      ["invalid_url", 400, "Invalid recipe URL"],
      ["unsupported_platform", 400, "Unsupported platform"],
      ["extraction_failed", 422, "Recipe could not be extracted"],
    ] as const)("maps %s to %i", async (_kind, status, error) => {
      // Wire the injected extraction dependency to throw the matching kind.
      const { app } = server();
      const response = await app.inject({ method: "POST", url: "/api/imports", headers: AUTH, payload: validBody });

      expect(response.statusCode).toBe(status);
      expect(response.json().error).toBe(error);
    });

    it("never echoes an underlying message, stack, or provider detail", async () => {
      const { app } = server();
      const response = await app.inject({ method: "POST", url: "/api/imports", headers: AUTH, payload: validBody });

      expect(response.body).not.toContain("sk-ant");
      expect(response.body).not.toContain("password");
      expect(response.body).not.toContain("    at ");
    });

    it("carries success, error, and requestId, and nothing else", async () => {
      const { app } = server();
      const response = await app.inject({
        method: "POST",
        url: "/api/imports",
        headers: AUTH,
        payload: { schemaVersion: 1, url: "not a url" },
      });

      expect(Object.keys(response.json()).sort()).toEqual(["error", "requestId", "success"]);
    });
  });

  describe("Idempotency-Key", () => {
    it("succeeds without one, because it is optional on this endpoint", async () => {
      const { app } = server();
      const response = await app.inject({ method: "POST", url: "/api/imports", headers: AUTH, payload: validBody });

      expect(response.statusCode).toBe(200);
    });

    it("accepts one without changing the response shape", async () => {
      const { app } = server();
      const response = await app.inject({
        method: "POST",
        url: "/api/imports",
        headers: { ...AUTH, "idempotency-key": "client-key-1" },
        payload: validBody,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().schemaVersion).toBe(1);
    });
  });
});

describe("CONTRACT GAPS for POST /api/imports", () => {
  it.each(["QA-012", "QA-013"])("%s is recorded as unresolved, not assumed", (id) => {
    // Both block an assertion the specification above would otherwise make.
    // They are listed rather than guessed at, per the QA brief: surface an
    // untestable contract instead of rewriting it.
    expect(gap(id).blocks.length).toBeGreaterThan(0);
    expect(gap(id).severity).toBe("blocks-ios-client");
  });
});
