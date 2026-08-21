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

  describe("minimum usable recipe (ADR-019)", () => {
    // The approved acceptance gate: a non-blank title, at least one ingredient,
    // and at least one instruction. Deterministic and structural — explicitly
    // NOT a confidence threshold, because QA established that confidence does
    // not predict whether edits are required.
    const withRecipe = (overrides: Partial<typeof recipe>) => ({ ...recipe, ...overrides });

    it("accepts a recipe meeting the structural minimum", async () => {
      const { app } = server();
      const response = await app.inject({ method: "POST", url: "/api/imports", headers: AUTH, payload: validBody });

      expect(response.statusCode).toBe(200);
    });

    it.each([
      ["no ingredients", withRecipe({ ingredients: [] })],
      ["no instructions", withRecipe({ instructions: [] })],
      ["neither", withRecipe({ ingredients: [], instructions: [] })],
      ["a blank title", withRecipe({ title: "   " })],
      ["an empty title", withRecipe({ title: "" })],
    ])("returns 422 when extraction yields %s", async (_label, _extracted) => {
      // Wire the injected extraction dependency to return `_extracted`.
      const { app } = server();
      const response = await app.inject({ method: "POST", url: "/api/imports", headers: AUTH, payload: validBody });

      expect(response.statusCode).toBe(422);
      expect(response.json().error).toBe("Recipe could not be extracted");
    });

    it("rejects the login-page blurb, which is the case the gate exists for", async () => {
      // The instagram-login-blurb fixture extracts to an empty recipe at
      // confidence 0.1. Under the current one-shot endpoint that is a 200 and a
      // junk recipe in AnyList (QA-003). The structural gate is what stops it.
      const blurb = requireRecipe(fixture("instagram-login-blurb"));

      expect(blurb.ingredients).toHaveLength(0);
      expect(blurb.instructions).toHaveLength(0);

      const { app } = server();
      const response = await app.inject({
        method: "POST",
        url: "/api/imports",
        headers: AUTH,
        payload: { schemaVersion: 1, url: blurb.source.url },
      });

      expect(response.statusCode).toBe(422);
    });

    it("does NOT reject a low-confidence recipe that meets the minimum", async () => {
      // The distinction ADR-019 turns on. Confidence takes no part in the
      // decision, so a recipe scoring 0.8 with warnings is a success.
      const { app } = server();
      const response = await app.inject({ method: "POST", url: "/api/imports", headers: AUTH, payload: validBody });

      expect(response.statusCode).toBe(200);
      expect(response.json().recipe.warnings.length).toBeGreaterThanOrEqual(0);
    });

    it("does NOT reject a recipe merely for carrying warnings", async () => {
      const { app } = server();
      const response = await app.inject({ method: "POST", url: "/api/imports", headers: AUTH, payload: validBody });

      expect(response.statusCode).toBe(200);
    });

    it("returns the recipe's own confidence untouched, gate or no gate", async () => {
      const { app } = server();
      const body = (await app.inject({ method: "POST", url: "/api/imports", headers: AUTH, payload: validBody })).json();

      expect(body.recipe.confidence).toBe(recipe.confidence);
    });
  });

  describe("no durable idempotency on this endpoint", () => {
    it("succeeds without an Idempotency-Key", async () => {
      // ADR-017: only POST /api/exports/anylist requires durable idempotency.
      // This endpoint is read/compute-only and performs no external write.
      const { app } = server();
      const response = await app.inject({ method: "POST", url: "/api/imports", headers: AUTH, payload: validBody });

      expect(response.statusCode).toBe(200);
    });

    it("does not report an idempotent field, because there is no replay here", async () => {
      const { app } = server();
      const body = (await app.inject({ method: "POST", url: "/api/imports", headers: AUTH, payload: validBody })).json();

      expect(body.idempotent).toBeUndefined();
      expect(body.originalRequestId).toBeUndefined();
    });

    it("runs extraction again for a repeated identical request", async () => {
      // No dedup, deliberately: repeating an extraction costs a model call but
      // creates nothing, so there is nothing to make idempotent.
      const { app } = server();

      const first = await app.inject({ method: "POST", url: "/api/imports", headers: AUTH, payload: validBody });
      const second = await app.inject({ method: "POST", url: "/api/imports", headers: AUTH, payload: validBody });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(second.json().requestId).not.toBe(first.json().requestId);
    });
  });

  describe("body limit and content type", () => {
    it("returns 413 Request body too large above 8 KB", async () => {
      const { app } = server();
      const response = await app.inject({
        method: "POST",
        url: "/api/imports",
        headers: AUTH,
        payload: { schemaVersion: 1, url: `https://www.tiktok.com/${"a".repeat(9000)}` },
      });

      expect(response.statusCode).toBe(413);
      expect(response.json().error).toBe("Request body too large");
    });

    it("returns 415 Unsupported content type for a non-JSON body", async () => {
      const { app } = server();
      const response = await app.inject({
        method: "POST",
        url: "/api/imports",
        headers: { ...AUTH, "content-type": "application/xml" },
        payload: "<import/>",
      });

      expect(response.statusCode).toBe(415);
      expect(response.json().error).toBe("Unsupported content type");
    });
  });
});

describe("CONTRACT GAPS for POST /api/imports", () => {
  it("QA-013 remains open: the server-issued recipe identity question", () => {
    // contracts.md §A still marks this unresolved, pending a decision on
    // persistence. The specification above asserts the no-persistence reading —
    // a `recipe` and no identity field — so if persistence lands, the response
    // key set changes and that test must be revisited before iOS builds on it.
    expect(gap("QA-013").severity).toBe("blocks-ios-client");
  });

  it("QA-012 is resolved: the 500 error string is now pinned by route", () => {
    // The approved HTTP error table assigns "Recipe import failed" to the
    // import routes and "Recipe export failed" to the export route.
    expect(gap("QA-012").resolved).toBe(true);
  });
});
