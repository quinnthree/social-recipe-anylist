import { describe, expect, it, vi } from "vitest";

import { fixture } from "../../fixtures/corpus.js";
import { requireRecipe } from "../../fixtures/types.js";
import type { ImportResult } from "../../src/app/import-service.js";
import { buildServer } from "../../src/http/server.js";
import { RecipeSchema } from "../../src/recipe/schema.js";
import { gap } from "./contract-gaps.js";

/**
 * POST /api/exports/anylist — export only. Proposed in contracts.md Part 2 §B
 * and NOT IMPLEMENTED.
 *
 * Structured like imports-endpoint.test.ts: active tripwires proving the route
 * does not exist, then a full skipped specification.
 *
 * This endpoint is the first time the canonical Recipe is an *inbound*
 * contract, which is what makes the strict-validation and provenance tests
 * below the important ones.
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

const validBody = { schemaVersion: 1, recipe };

/** The recipe as the user might have corrected it on the review screen. */
const editedRecipe = {
  ...recipe,
  title: "Cottage Cheese Brownies (half batch)",
  servings: 4,
  ingredients: recipe.ingredients.map((ingredient) =>
    ingredient.name === "cottage cheese" ? { ...ingredient, quantity: "8" } : ingredient,
  ),
};

describe("POST /api/exports/anylist — not implemented today", () => {
  it("is not routed", async () => {
    const { app } = server();
    const response = await app.inject({
      method: "POST",
      url: "/api/exports/anylist",
      headers: AUTH,
      payload: validBody,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ success: false, error: "Not found" });
  });

  it("is still behind authentication even though it does not exist", async () => {
    const { app } = server();
    const response = await app.inject({
      method: "POST",
      url: "/api/exports/anylist",
      payload: validBody,
    });

    expect(response.statusCode).toBe(401);
  });

  it("does not reach the import pipeline", async () => {
    const { app, importRecipe } = server();
    await app.inject({ method: "POST", url: "/api/exports/anylist", headers: AUTH, payload: validBody });

    expect(importRecipe).not.toHaveBeenCalled();
  });
});

describe("the edited recipe used by the specification is itself valid", () => {
  // Guards the fixture rather than the endpoint: if this stopped being a valid
  // canonical Recipe, the "accepts an edited recipe" specs below would pass for
  // the wrong reason once enabled.
  it("passes canonical validation after the user's edits", () => {
    expect(RecipeSchema.safeParse(editedRecipe).success).toBe(true);
  });

  it("differs from the extracted recipe in the fields a user would change", () => {
    expect(editedRecipe.title).not.toBe(recipe.title);
    expect(editedRecipe.servings).not.toBe(recipe.servings);
  });

  it("leaves source provenance untouched", () => {
    expect(editedRecipe.source).toEqual(recipe.source);
  });
});

/**
 * ENABLE THIS BLOCK when POST /api/exports/anylist lands. Change
 * `describe.skip` to `describe` and delete the "not implemented today" block.
 *
 * The Backend agent will need an injectable RecipeSaver on ServerDeps so these
 * run without touching AnyList. `AnyListRecipeSaver` already sits behind the
 * `RecipeSaver` interface (ADR-002), so the seam exists; it just is not
 * reachable from buildServer yet.
 */
describe.skip("POST /api/exports/anylist — specification (contracts.md Part 2 §B)", () => {
  describe("schemaVersion and strict validation", () => {
    it("accepts schemaVersion 1 and echoes it", async () => {
      const { app } = server();
      const response = await app.inject({ method: "POST", url: "/api/exports/anylist", headers: AUTH, payload: validBody });

      expect(response.statusCode).toBe(200);
      expect(response.json().schemaVersion).toBe(1);
    });

    it("rejects a missing or non-integer schemaVersion", async () => {
      const { app } = server();

      for (const payload of [{ recipe }, { schemaVersion: "1", recipe }, { schemaVersion: 1.5, recipe }]) {
        const response = await app.inject({ method: "POST", url: "/api/exports/anylist", headers: AUTH, payload });

        expect(response.statusCode).toBe(400);
        expect(response.json().error).toBe("Invalid request body");
      }
    });

    it("rejects an unsupported schema version distinctly", async () => {
      const { app } = server();
      const response = await app.inject({
        method: "POST",
        url: "/api/exports/anylist",
        headers: AUTH,
        payload: { schemaVersion: 2, recipe },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("Unsupported schema version");
    });

    it("rejects an unknown key at the top level", async () => {
      const { app } = server();
      const response = await app.inject({
        method: "POST",
        url: "/api/exports/anylist",
        headers: AUTH,
        payload: { ...validBody, listId: "shopping" },
      });

      expect(response.statusCode).toBe(400);
    });

    it("rejects an unknown key inside the recipe", async () => {
      // The canonical schema strips unknown keys rather than rejecting them
      // (QA-006). Meeting ADR-011 requires the endpoint to wrap it in a strict
      // schema; this is the test that proves it did.
      const { app } = server();
      const response = await app.inject({
        method: "POST",
        url: "/api/exports/anylist",
        headers: AUTH,
        payload: { schemaVersion: 1, recipe: { ...recipe, nutritionScore: 8 } },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("Invalid request body");
    });

    it("rejects an unknown key inside an ingredient", async () => {
      const { app } = server();
      const response = await app.inject({
        method: "POST",
        url: "/api/exports/anylist",
        headers: AUTH,
        payload: {
          schemaVersion: 1,
          recipe: { ...recipe, ingredients: [{ ...recipe.ingredients[0], optional: true }] },
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("canonical Recipe validation", () => {
    it.each([
      ["a missing title", { ...recipe, title: undefined }],
      ["an empty title", { ...recipe, title: "" }],
      ["a bad platform", { ...recipe, source: { ...recipe.source, platform: "pinterest" } }],
      ["a negative servings", { ...recipe, servings: -1 }],
      ["confidence above 1", { ...recipe, confidence: 2 }],
      ["an omitted nullable field", { ...recipe, description: undefined }],
    ])("rejects %s with 400 Invalid recipe", async (_label, body) => {
      const { app } = server();
      const response = await app.inject({
        method: "POST",
        url: "/api/exports/anylist",
        headers: AUTH,
        payload: { schemaVersion: 1, recipe: body },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("Invalid recipe");
    });

    it("accepts a recipe the user edited, as long as it is still valid", async () => {
      const { app } = server();
      const response = await app.inject({
        method: "POST",
        url: "/api/exports/anylist",
        headers: AUTH,
        payload: { schemaVersion: 1, recipe: editedRecipe },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().saved.name).toBe(editedRecipe.title);
    });

    it("never rejects an export because the recipe carries extraction warnings", async () => {
      // ADR-010: warnings are an extraction-time historical record. A recipe
      // carrying them is a normal, exportable recipe.
      const { app } = server();
      const warned = {
        ...recipe,
        confidence: 0.5,
        warnings: ["No servings were stated in the source text.", "No ingredients were found in the source text."],
      };
      const response = await app.inject({
        method: "POST",
        url: "/api/exports/anylist",
        headers: AUTH,
        payload: { schemaVersion: 1, recipe: warned },
      });

      expect(response.statusCode).toBe(200);
    });

    it("does not recompute confidence or warnings", async () => {
      // ADR-010: the export path must not reassess. Whatever it does with them,
      // it must not write a different value back.
      const { app } = server();
      const response = await app.inject({
        method: "POST",
        url: "/api/exports/anylist",
        headers: AUTH,
        payload: { schemaVersion: 1, recipe: { ...editedRecipe, confidence: 0.42, warnings: ["kept"] } },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('"confidence":1');
    });
  });

  describe("source provenance", () => {
    it("accepts an altered source.url, because the invariant is not server-verifiable", async () => {
      // ADR-013, asserted honestly. The contract says the Review UI must not
      // offer editing of provenance; the server has no way to prove it was not
      // edited, and V1 deliberately adds none. Anyone reading this test should
      // come away knowing the invariant rests on client cooperation.
      const { app } = server();
      const response = await app.inject({
        method: "POST",
        url: "/api/exports/anylist",
        headers: AUTH,
        payload: {
          schemaVersion: 1,
          recipe: { ...recipe, source: { ...recipe.source, url: "https://example.com/not-the-source" } },
        },
      });

      expect(response.statusCode).toBe(200);
    });

    it("still enforces the shape of the provenance fields", async () => {
      const { app } = server();
      const response = await app.inject({
        method: "POST",
        url: "/api/exports/anylist",
        headers: AUTH,
        payload: { schemaVersion: 1, recipe: { ...recipe, source: { ...recipe.source, url: "not a url" } } },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("the export itself", () => {
    it("returns the verified AnyList result", async () => {
      // 200 only after getRecipeById confirmed the recipe exists, as today.
      const { app } = server();
      const body = (await app.inject({ method: "POST", url: "/api/exports/anylist", headers: AUTH, payload: validBody })).json();

      expect(body.success).toBe(true);
      expect(typeof body.saved.id).toBe("string");
      expect(body.idempotent).toBe(false);
    });

    it("performs no extraction", async () => {
      // No source fetch, no Anthropic call. The recipe arrives in the body.
      const { app, importRecipe } = server();
      await app.inject({ method: "POST", url: "/api/exports/anylist", headers: AUTH, payload: validBody });

      expect(importRecipe).not.toHaveBeenCalled();
    });

    it("maps an AnyList failure to 500 Recipe export failed", async () => {
      const { app } = server();
      const response = await app.inject({ method: "POST", url: "/api/exports/anylist", headers: AUTH, payload: validBody });

      expect(response.statusCode).toBe(500);
      expect(response.json().error).toBe("Recipe export failed");
    });

    it("leaks nothing from an AnyList failure", async () => {
      const { app } = server();
      const response = await app.inject({ method: "POST", url: "/api/exports/anylist", headers: AUTH, payload: validBody });

      expect(response.body).not.toContain("password");
      expect(response.body).not.toContain("@");
      expect(response.body).not.toContain("    at ");
    });
  });

  describe("request IDs", () => {
    it("returns a requestId matching the X-Request-Id header", async () => {
      const { app } = server();
      const response = await app.inject({ method: "POST", url: "/api/exports/anylist", headers: AUTH, payload: validBody });

      expect(response.headers["x-request-id"]).toBe(response.json().requestId);
    });

    it("adopts a client-supplied X-Request-Id", async () => {
      const { app } = server();
      const response = await app.inject({
        method: "POST",
        url: "/api/exports/anylist",
        headers: { ...AUTH, "x-request-id": "ios-export-7" },
        payload: validBody,
      });

      expect(response.json().requestId).toBe("ios-export-7");
    });

    it("returns a requestId on a failure too", async () => {
      const { app } = server();
      const response = await app.inject({
        method: "POST",
        url: "/api/exports/anylist",
        headers: AUTH,
        payload: { schemaVersion: 1, recipe: { ...recipe, title: "" } },
      });

      expect(typeof response.json().requestId).toBe("string");
    });
  });

  describe("Idempotency-Key", () => {
    it("succeeds without one, because the contract only recommends it", async () => {
      const { app } = server();
      const response = await app.inject({ method: "POST", url: "/api/exports/anylist", headers: AUTH, payload: validBody });

      expect(response.statusCode).toBe(200);
    });

    it("replays the original response for the same key and body, with no second write", async () => {
      const { app } = server();
      const headers = { ...AUTH, "idempotency-key": "export-key-1" };

      const first = await app.inject({ method: "POST", url: "/api/exports/anylist", headers, payload: validBody });
      const second = await app.inject({ method: "POST", url: "/api/exports/anylist", headers, payload: validBody });

      expect(first.json().idempotent).toBe(false);
      expect(second.json().idempotent).toBe(true);
      expect(second.json().saved.id).toBe(first.json().saved.id);
    });

    it("conflicts for the same key with a different body", async () => {
      const { app } = server();
      const headers = { ...AUTH, "idempotency-key": "export-key-2" };

      await app.inject({ method: "POST", url: "/api/exports/anylist", headers, payload: validBody });
      const conflict = await app.inject({
        method: "POST",
        url: "/api/exports/anylist",
        headers,
        payload: { schemaVersion: 1, recipe: editedRecipe },
      });

      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().error).toBe("Idempotency key conflict");
    });

    it("lets at most one of two concurrent same-key requests write", async () => {
      const { app } = server();
      const headers = { ...AUTH, "idempotency-key": "export-key-3" };

      const responses = await Promise.all([
        app.inject({ method: "POST", url: "/api/exports/anylist", headers, payload: validBody }),
        app.inject({ method: "POST", url: "/api/exports/anylist", headers, payload: validBody }),
      ]);

      // Exactly one may have performed the export. The other must not have
      // called createRecipe, whatever it returned.
      expect(responses.filter((r) => r.json().idempotent === false).length).toBeLessThanOrEqual(1);
    });
  });
});

describe("CONTRACT GAPS for POST /api/exports/anylist", () => {
  it.each(["QA-011", "QA-014", "QA-015", "QA-017", "QA-018"])(
    "%s is recorded as unresolved, not assumed",
    (id) => {
      expect(gap(id).blocks.length).toBeGreaterThan(0);
    },
  );

  it("leaves the IN_PROGRESS and AMBIGUOUS replay responses unspecified", () => {
    // Which is why no test above asserts them. Two of the five idempotency
    // states have no defined response, so a client cannot handle them.
    expect(gap("QA-011").severity).toBe("blocks-ios-client");
  });
});
