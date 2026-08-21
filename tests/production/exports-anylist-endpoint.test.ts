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

  describe("Idempotency-Key is required", () => {
    // ADR-017: required on this route, 1–128 characters. The earlier draft only
    // recommended it and allowed 255 (QA-015).
    const headersWith = (key: string) => ({ ...AUTH, "idempotency-key": key });

    it("rejects a request with no Idempotency-Key", async () => {
      const { app } = server();
      const response = await app.inject({
        method: "POST",
        url: "/api/exports/anylist",
        headers: AUTH,
        payload: validBody,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("Invalid idempotency key");
    });

    it("rejects an empty Idempotency-Key", async () => {
      const { app } = server();
      const response = await app.inject({
        method: "POST",
        url: "/api/exports/anylist",
        headers: headersWith(""),
        payload: validBody,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("Invalid idempotency key");
    });

    it("rejects an Idempotency-Key longer than 128 characters", async () => {
      const { app } = server();
      const response = await app.inject({
        method: "POST",
        url: "/api/exports/anylist",
        headers: headersWith("x".repeat(129)),
        payload: validBody,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("Invalid idempotency key");
    });

    it("accepts a key at the 128-character boundary", async () => {
      const { app } = server();
      const response = await app.inject({
        method: "POST",
        url: "/api/exports/anylist",
        headers: headersWith("x".repeat(128)),
        payload: validBody,
      });

      expect(response.statusCode).toBe(200);
    });

    it("never writes to AnyList when the key is invalid", async () => {
      // The key is validated before anything is claimed or executed.
      const { app } = server();
      const response = await app.inject({
        method: "POST",
        url: "/api/exports/anylist",
        headers: AUTH,
        payload: validBody,
      });

      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain("saved");
    });
  });

  describe("idempotent replay", () => {
    const headers = { ...AUTH, "idempotency-key": "export-key-1" };

    it("reports idempotent false on the first execution", async () => {
      const { app } = server();
      const response = await app.inject({
        method: "POST",
        url: "/api/exports/anylist",
        headers,
        payload: validBody,
      });

      expect(response.json().idempotent).toBe(false);
    });

    it("replays the recorded result without a second AnyList write", async () => {
      const { app } = server();

      const first = await app.inject({ method: "POST", url: "/api/exports/anylist", headers, payload: validBody });
      const second = await app.inject({ method: "POST", url: "/api/exports/anylist", headers, payload: validBody });

      expect(second.statusCode).toBe(200);
      expect(second.json().idempotent).toBe(true);
      expect(second.json().saved.id).toBe(first.json().saved.id);
    });

    it("omits originalRequestId on a first execution", async () => {
      const { app } = server();
      const response = await app.inject({
        method: "POST",
        url: "/api/exports/anylist",
        headers,
        payload: validBody,
      });

      expect(response.json().originalRequestId).toBeUndefined();
    });

    it("carries both request ids on a replay, and they differ", async () => {
      // Without both, a replay is indistinguishable from a fresh success in
      // logs, which makes duplicate investigation guesswork.
      const { app } = server();

      const first = await app.inject({ method: "POST", url: "/api/exports/anylist", headers, payload: validBody });
      const second = await app.inject({ method: "POST", url: "/api/exports/anylist", headers, payload: validBody });

      expect(second.json().originalRequestId).toBe(first.json().requestId);
      expect(second.json().requestId).not.toBe(second.json().originalRequestId);
    });

    it("does not treat a re-serialised identical recipe as a different request", async () => {
      // ADR-018: the fingerprint is over the validated, normalised value, so
      // key ordering must not produce a false 409.
      const reordered = {
        recipe: Object.fromEntries(Object.entries(recipe).reverse()),
        schemaVersion: 1,
      };
      const { app } = server();

      await app.inject({ method: "POST", url: "/api/exports/anylist", headers, payload: validBody });
      const replay = await app.inject({ method: "POST", url: "/api/exports/anylist", headers, payload: reordered });

      expect(replay.statusCode).toBe(200);
      expect(replay.json().idempotent).toBe(true);
    });
  });

  describe("idempotency conflicts, all 409", () => {
    it("returns 409 Idempotency key conflict for the same key with a different recipe", async () => {
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

    it("returns 409 Export already in progress while the first export runs", async () => {
      // Requires the injected saver to block. Exactly one of the two may reach
      // createRecipe; the other must be refused, never queued behind it.
      const { app } = server();
      const headers = { ...AUTH, "idempotency-key": "export-key-3" };

      const [a, b] = await Promise.all([
        app.inject({ method: "POST", url: "/api/exports/anylist", headers, payload: validBody }),
        app.inject({ method: "POST", url: "/api/exports/anylist", headers, payload: validBody }),
      ]);

      const statuses = [a.statusCode, b.statusCode].sort();
      expect(statuses).toEqual([200, 409]);

      const refused = a.statusCode === 409 ? a : b;
      expect(refused.json().error).toBe("Export already in progress");
    });

    it("returns 409 Export outcome unknown after an ambiguous write", async () => {
      // Wire the injected saver to fail with an AMBIGUOUS-mapped AnyList code
      // (create_failed, verify_unreadable, or verify_missing), then retry.
      const { app } = server();
      const headers = { ...AUTH, "idempotency-key": "export-key-4" };

      await app.inject({ method: "POST", url: "/api/exports/anylist", headers, payload: validBody });
      const retry = await app.inject({ method: "POST", url: "/api/exports/anylist", headers, payload: validBody });

      expect(retry.statusCode).toBe(409);
      expect(retry.json().error).toBe("Export outcome unknown");
    });

    it("never calls createRecipe again for an ambiguous key", async () => {
      // The rule the whole state machine exists for (ADR-012, ADR-020). An
      // unnecessary duplicate cannot be cleaned up: deleteRecipe reports
      // success without deleting (ADR-021).
      const { app } = server();
      const headers = { ...AUTH, "idempotency-key": "export-key-5" };

      await app.inject({ method: "POST", url: "/api/exports/anylist", headers, payload: validBody });
      const retry = await app.inject({ method: "POST", url: "/api/exports/anylist", headers, payload: validBody });

      expect(retry.statusCode).toBe(409);
    });

    it("retries after a login failure, which is the one safe case", async () => {
      // login_failed → FAILED_SAFE → atomic re-claim → retry (ADR-020).
      const { app } = server();
      const headers = { ...AUTH, "idempotency-key": "export-key-6" };

      const failed = await app.inject({ method: "POST", url: "/api/exports/anylist", headers, payload: validBody });
      expect(failed.statusCode).toBe(500);

      const retry = await app.inject({ method: "POST", url: "/api/exports/anylist", headers, payload: validBody });
      expect(retry.statusCode).toBe(200);
      expect(retry.json().idempotent).toBe(false);
    });

    it("carries a requestId on every 409", async () => {
      const { app } = server();
      const headers = { ...AUTH, "idempotency-key": "export-key-7" };

      await app.inject({ method: "POST", url: "/api/exports/anylist", headers, payload: validBody });
      const conflict = await app.inject({
        method: "POST",
        url: "/api/exports/anylist",
        headers,
        payload: { schemaVersion: 1, recipe: editedRecipe },
      });

      expect(conflict.headers["x-request-id"]).toBe(conflict.json().requestId);
    });
  });

  describe("inbound hardening (ADR-024)", () => {
    const headers = { ...AUTH, "idempotency-key": "hardening-key" };
    const post = (recipeBody: unknown) =>
      server().app.inject({
        method: "POST",
        url: "/api/exports/anylist",
        headers,
        payload: { schemaVersion: 1, recipe: recipeBody },
      });

    it("rejects a whitespace-only title", async () => {
      const response = await post({ ...recipe, title: "   " });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("Invalid recipe");
    });

    it.each(["file:///etc/passwd", "javascript:alert(1)", "data:text/plain,x", "ftp://h/x"])(
      "rejects a source.url of %s",
      async (url) => {
        const response = await post({ ...recipe, source: { ...recipe.source, url } });

        expect(response.statusCode).toBe(400);
        expect(response.json().error).toBe("Invalid recipe");
      },
    );

    it.each(["https://www.tiktok.com/@a/video/1", "http://www.tiktok.com/@a/video/1"])(
      "accepts a source.url of %s",
      async (url) => {
        expect((await post({ ...recipe, source: { ...recipe.source, url } })).statusCode).toBe(200);
      },
    );

    it("rejects maxMinutes below minMinutes", async () => {
      const response = await post({ ...recipe, cookTime: { minMinutes: 40, maxMinutes: 35 } });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("Invalid recipe");
    });

    it("accepts maxMinutes equal to minMinutes", async () => {
      // Legal inbound by ADR-024 even though our extraction never emits it.
      // See QA-020: the AnyList note renders this shape as "40–40 minutes"
      // until describeTime is corrected.
      expect(
        (await post({ ...recipe, cookTime: { minMinutes: 40, maxMinutes: 40 } })).statusCode,
      ).toBe(200);
    });

    it("does not render an accepted { n, n } cook time as a range", async () => {
      // The consumer-visible half of QA-020. This is the assertion that fails
      // until src/anylist/mapping.ts is fixed.
      const response = await post({ ...recipe, cookTime: { minMinutes: 40, maxMinutes: 40 } });

      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain("40–40");
    });
  });

  describe("body limit and content type", () => {
    const headers = { ...AUTH, "idempotency-key": "limits-key" };

    it("allows a recipe body up to 64 KB", async () => {
      // Exports carry a full canonical Recipe, hence the larger allowance.
      const large = {
        ...recipe,
        instructions: [recipe.instructions[0] ?? "Blend.", "x".repeat(40_000)],
      };
      const { app } = server();
      const response = await app.inject({
        method: "POST",
        url: "/api/exports/anylist",
        headers,
        payload: { schemaVersion: 1, recipe: large },
      });

      expect(response.statusCode).toBe(200);
    });

    it("returns 413 Request body too large above 64 KB", async () => {
      const huge = { ...recipe, instructions: ["x".repeat(70_000)] };
      const { app } = server();
      const response = await app.inject({
        method: "POST",
        url: "/api/exports/anylist",
        headers,
        payload: { schemaVersion: 1, recipe: huge },
      });

      expect(response.statusCode).toBe(413);
      expect(response.json().error).toBe("Request body too large");
    });

    it("returns 415 Unsupported content type for a non-JSON body", async () => {
      const { app } = server();
      const response = await app.inject({
        method: "POST",
        url: "/api/exports/anylist",
        headers: { ...headers, "content-type": "application/xml" },
        payload: "<recipe/>",
      });

      expect(response.statusCode).toBe(415);
      expect(response.json().error).toBe("Unsupported content type");
    });
  });
});

describe("CONTRACT GAPS for POST /api/exports/anylist", () => {
  it.each(["QA-011", "QA-014", "QA-015", "QA-017"])(
    "%s was resolved by the approved contract",
    (id) => {
      expect(gap(id).resolved).toBe(true);
      expect(gap(id).resolution).toBeTruthy();
    },
  );

  it("QA-021 remains open: retention versus the stale-IN_PROGRESS rule", () => {
    // Within 24 hours a stale IN_PROGRESS becomes AMBIGUOUS and is never
    // re-claimed. At the TTL boundary the record is deleted, so the same key
    // and the same fingerprint become claimable again and a retry writes a
    // second time. No spec above asserts past-24-hour behaviour.
    expect(gap("QA-021").resolved).toBe(false);
  });

  it("QA-018 remains open: no response field reflects what AnyList stored", () => {
    // saved.name is the submitted title and saved.id is client-generated
    // (ADR-021), so read-back proves existence and nothing more.
    expect(gap("QA-018").severity).toBe("documentation");
  });

  it("QA-023 remains open: only title is hardened against whitespace", () => {
    expect(gap("QA-023").resolved).toBe(false);
  });
});
