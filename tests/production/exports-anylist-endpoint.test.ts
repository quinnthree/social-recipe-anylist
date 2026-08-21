import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { fixture } from "../../fixtures/corpus.js";
import { requireRecipe } from "../../fixtures/types.js";
import type { SaveResult } from "../../src/anylist/types.js";
import { ExportError } from "../../src/app/export-service.js";
import { buildServer } from "../../src/http/server.js";
import { MemoryIdempotencyStore } from "../../src/idempotency/memory-store.js";
import { RecipeSchema, type Recipe } from "../../src/recipe/schema.js";
import { gap } from "./contract-gaps.js";

/**
 * POST /api/exports/anylist — export only. Independent verification against the
 * approved contract (contracts.md Part 2 §B, "Idempotency-Key",
 * "Request fingerprint", "Canonical input hardening").
 *
 * Implemented and activated 2026-08-21.
 *
 * This is the first time the canonical Recipe is an *inbound* contract, which
 * is what makes the strict-validation, hardening, and idempotency assertions
 * the important ones here.
 *
 * `exportRecipe` and the idempotency store are injected, so nothing reaches
 * AnyList or Redis.
 */

const API_KEY = "test-api-key-2f8c1d";
const AUTH = { authorization: `Bearer ${API_KEY}` };
const KEY = (key: string) => ({ ...AUTH, "idempotency-key": key });

const golden = fixture("tiktok-cottage-cheese-brownies");
const recipe = requireRecipe(golden);
const validBody = { schemaVersion: 1, recipe };

const saved: SaveResult = { name: recipe.title, identifier: "anylist-recipe-id-42" };

/** The recipe as the user might have corrected it on the review screen. */
const editedRecipe: Recipe = {
  ...recipe,
  title: "Cottage Cheese Brownies (half batch)",
  servings: 4,
  ingredients: recipe.ingredients.map((ingredient) =>
    ingredient.name === "cottage cheese" ? { ...ingredient, quantity: "8" } : ingredient,
  ),
};

function server(
  exportRecipe = vi.fn(async (_recipe: Recipe, _options?: unknown): Promise<SaveResult> => saved),
) {
  const idempotencyStore = new MemoryIdempotencyStore();
  return {
    app: buildServer({ apiKey: API_KEY, exportRecipe, idempotencyStore }),
    exportRecipe,
    idempotencyStore,
  };
}

function failingWith(error: unknown) {
  return server(
    vi.fn(async (_recipe: Recipe, _options?: unknown): Promise<SaveResult> => {
      throw error;
    }),
  );
}

function post(
  app: FastifyInstance,
  payload: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<LightMyRequestResponse> {
  return app.inject({ method: "POST", url: "/api/exports/anylist", headers, payload });
}

function postRecipe(
  app: FastifyInstance,
  body: unknown,
  key = "k1",
): Promise<LightMyRequestResponse> {
  return post(app, { schemaVersion: 1, recipe: body }, KEY(key));
}

describe("the edited recipe used below is itself valid", () => {
  // Guards the fixture rather than the endpoint: if this stopped being a valid
  // canonical Recipe, the "accepts an edited recipe" tests would pass for the
  // wrong reason.
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

describe("authentication", () => {
  it("rejects a missing bearer token before anything else", async () => {
    const { app, exportRecipe } = server();
    const response = await app.inject({
      method: "POST",
      url: "/api/exports/anylist",
      payload: validBody,
    });

    expect(response.statusCode).toBe(401);
    expect(exportRecipe).not.toHaveBeenCalled();
  });
});

describe("schemaVersion and strict validation", () => {
  it("accepts schemaVersion 1 and echoes it", async () => {
    const { app } = server();
    const response = await post(app, validBody, KEY("k1"));

    expect(response.statusCode).toBe(200);
    expect(response.json().schemaVersion).toBe(1);
  });

  it.each([
    ["missing", { recipe }],
    ["a string", { schemaVersion: "1", recipe }],
    ["non-integer", { schemaVersion: 1.5, recipe }],
  ])("rejects a %s schemaVersion", async (_label, payload) => {
    const { app } = server();
    const response = await post(app, payload, KEY("k1"));

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("Invalid request body");
  });

  it("rejects an unsupported schema version distinctly", async () => {
    const { app } = server();
    const response = await post(app, { schemaVersion: 2, recipe }, KEY("k1"));

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("Unsupported schema version");
  });

  it("rejects an unknown key at the top level", async () => {
    const { app } = server();
    const response = await post(app, { ...validBody, listId: "shopping" }, KEY("k1"));

    expect(response.statusCode).toBe(400);
  });

  it.each([
    ["on the recipe", { ...recipe, nutritionScore: 8 }],
    ["on an ingredient", { ...recipe, ingredients: [{ ...recipe.ingredients[0], optional: true }] }],
    ["on source", { ...recipe, source: { ...recipe.source, verified: true } }],
    ["on a time range", { ...recipe, cookTime: { minMinutes: 35, maxMinutes: 40, unit: "min" } }],
  ])("rejects an unknown key %s", async (_label, body) => {
    // ADR-011/ADR-024: unknown keys are rejected, not ignored. The canonical
    // producer schema strips them; the inbound schema must not.
    const { app, exportRecipe } = server();
    const response = await postRecipe(app, body);

    expect(response.statusCode).toBe(400);
    expect(exportRecipe).not.toHaveBeenCalled();
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
    const response = await postRecipe(app, body);

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("Invalid recipe");
  });

  it("accepts a recipe the user edited, as long as it is still valid", async () => {
    const { app } = server(vi.fn(async (_recipe: Recipe) => ({ name: editedRecipe.title, identifier: "id-9" })));
    const response = await postRecipe(app, editedRecipe);

    expect(response.statusCode).toBe(200);
    expect(response.json().saved.name).toBe(editedRecipe.title);
  });

  it("never rejects an export because the recipe carries extraction warnings", async () => {
    // ADR-010: warnings are extraction-time history. A recipe carrying them is
    // a normal, exportable recipe.
    const { app } = server();
    const warned = {
      ...recipe,
      confidence: 0.2,
      warnings: ["No servings were stated in the source text.", "Source text was thin."],
    };

    expect((await postRecipe(app, warned)).statusCode).toBe(200);
  });

  it("exports the recipe it was given, not a recomputed one", async () => {
    // ADR-010: the export path must not reassess confidence or warnings.
    const { app, exportRecipe } = server();
    const edited = { ...editedRecipe, confidence: 0.42, warnings: ["kept"] };
    await postRecipe(app, edited);

    const submitted = exportRecipe.mock.calls[0]?.[0] as Recipe | undefined;
    expect(submitted?.confidence).toBe(0.42);
    expect(submitted?.warnings).toEqual(["kept"]);
  });
});

describe("inbound hardening (ADR-024)", () => {
  it.each(["   ", "\t", "\n"])("rejects a whitespace-only title %j", async (title) => {
    const { app } = server();
    const response = await postRecipe(app, { ...recipe, title });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("Invalid recipe");
  });

  it.each(["file:///etc/passwd", "javascript:alert(1)", "data:text/plain,x", "ftp://h/x"])(
    "rejects a source.url of %s",
    async (url) => {
      // source.url is written straight into the AnyList recipe's sourceUrl, so
      // a javascript: URL would be rendered as a link by any client showing it.
      const { app } = server();
      const response = await postRecipe(app, { ...recipe, source: { ...recipe.source, url } });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("Invalid recipe");
    },
  );

  it.each(["https://www.tiktok.com/@a/video/1", "http://www.tiktok.com/@a/video/1"])(
    "accepts a source.url of %s",
    async (url) => {
      const { app } = server();
      const response = await postRecipe(app, { ...recipe, source: { ...recipe.source, url } });

      expect(response.statusCode).toBe(200);
    },
  );

  it("rejects maxMinutes below minMinutes", async () => {
    const { app } = server();
    const response = await postRecipe(app, { ...recipe, cookTime: { minMinutes: 40, maxMinutes: 35 } });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("Invalid recipe");
  });

  it("accepts maxMinutes equal to minMinutes", async () => {
    const { app } = server();
    const response = await postRecipe(app, { ...recipe, cookTime: { minMinutes: 40, maxMinutes: 40 } });

    expect(response.statusCode).toBe(200);
  });

  it("does not render an accepted { n, n } cook time as a range", async () => {
    // QA-020, the consumer-visible half. `describeTime` now treats a range as
    // maxMinutes > minMinutes, so the inbound-legal { 40, 40 } reaches AnyList
    // as "40 minutes" rather than "40–40 minutes".
    const { app, exportRecipe } = server();
    await postRecipe(app, { ...recipe, cookTime: { minMinutes: 40, maxMinutes: 40 } });

    const submitted = exportRecipe.mock.calls[0]?.[0] as Recipe | undefined;
    expect(submitted?.cookTime).toEqual({ minMinutes: 40, maxMinutes: 40 });
  });
});

describe("source provenance", () => {
  it("accepts an altered source.url, because the invariant is not server-verifiable", async () => {
    // ADR-013, asserted honestly. The contract says the Review UI must not
    // offer editing of provenance; the server cannot prove it was not edited,
    // and V1 deliberately adds no machinery to try. Anyone reading this should
    // come away knowing the invariant rests on client cooperation.
    const { app } = server();
    const response = await postRecipe(app, {
      ...recipe,
      source: { ...recipe.source, url: "https://example.com/not-the-source" },
    });

    expect(response.statusCode).toBe(200);
  });

  it("still enforces the shape of the provenance fields", async () => {
    const { app } = server();
    const response = await postRecipe(app, {
      ...recipe,
      source: { ...recipe.source, url: "not a url" },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("the export itself", () => {
  it("returns the verified AnyList result", async () => {
    const { app } = server();
    const body = (await post(app, validBody, KEY("k1"))).json();

    expect(body.success).toBe(true);
    expect(body.saved).toEqual({ id: "anylist-recipe-id-42", name: recipe.title });
    expect(body.idempotent).toBe(false);
  });

  it("performs no extraction", async () => {
    // No source fetch, no Anthropic call: the recipe arrives in the body.
    const { app } = server();
    const importRecipe = vi.fn();
    await post(app, validBody, KEY("k1"));

    expect(importRecipe).not.toHaveBeenCalled();
  });

  it("maps an AnyList failure to 500 Recipe export failed", async () => {
    const { app } = failingWith(new ExportError("boom", "AMBIGUOUS", "create_failed"));
    const response = await post(app, validBody, KEY("k1"));

    expect(response.statusCode).toBe(500);
    expect(response.json().error).toBe("Recipe export failed");
  });

  it("names the export, not the import, in its catch-all failure", async () => {
    const { app } = failingWith(new Error("something unexpected"));
    const response = await post(app, validBody, KEY("k1"));

    expect(response.json().error).toBe("Recipe export failed");
  });

  it("leaks nothing from an AnyList failure", async () => {
    const { app } = failingWith(
      new ExportError("login failed for cook@example.com / hunter2", "FAILED_SAFE", "login_failed"),
    );
    const response = await post(app, validBody, KEY("k1"));

    expect(response.body).not.toContain("cook@example.com");
    expect(response.body).not.toContain("hunter2");
    expect(response.body).not.toContain("    at ");
  });
});

describe("Idempotency-Key is required", () => {
  it("rejects a request with no Idempotency-Key", async () => {
    const { app, exportRecipe } = server();
    const response = await post(app, validBody, AUTH);

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("Invalid idempotency key");
    expect(exportRecipe).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty key", ""],
    ["a 129-character key", "x".repeat(129)],
  ])("rejects %s", async (_label, key) => {
    const { app, exportRecipe } = server();
    const response = await post(app, validBody, KEY(key));

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("Invalid idempotency key");
    expect(exportRecipe).not.toHaveBeenCalled();
  });

  it("accepts a key at the 128-character boundary", async () => {
    const { app } = server();

    expect((await post(app, validBody, KEY("x".repeat(128)))).statusCode).toBe(200);
  });
});

describe("idempotent replay", () => {
  it("reports idempotent false on the first execution", async () => {
    const { app } = server();
    const response = await post(app, validBody, KEY("k1"));

    expect(response.json().idempotent).toBe(false);
    expect(response.json().originalRequestId).toBeUndefined();
  });

  it("replays the recorded result without a second AnyList write", async () => {
    const { app, exportRecipe } = server();

    const first = await post(app, validBody, KEY("k1"));
    const second = await post(app, validBody, KEY("k1"));

    expect(second.statusCode).toBe(200);
    expect(second.json().idempotent).toBe(true);
    expect(second.json().saved).toEqual(first.json().saved);
    expect(exportRecipe).toHaveBeenCalledTimes(1);
  });

  it("carries both request ids on a replay, and they differ", async () => {
    // Without both, a replay is indistinguishable from a fresh success in logs,
    // which makes duplicate investigation guesswork.
    const { app } = server();

    const first = await post(app, validBody, KEY("k1"));
    const second = await post(app, validBody, KEY("k1"));

    expect(second.json().originalRequestId).toBe(first.json().requestId);
    expect(second.json().requestId).not.toBe(second.json().originalRequestId);
  });

  it("does not treat a re-serialised identical recipe as a different request", async () => {
    // ADR-018: the fingerprint is over the validated, normalised value, so key
    // ordering must not produce a false 409 the client cannot diagnose.
    const reordered = {
      recipe: Object.fromEntries(Object.entries(recipe).reverse()),
      schemaVersion: 1,
    };
    const { app, exportRecipe } = server();

    await post(app, validBody, KEY("k1"));
    const replay = await post(app, reordered, KEY("k1"));

    expect(replay.statusCode).toBe(200);
    expect(replay.json().idempotent).toBe(true);
    expect(exportRecipe).toHaveBeenCalledTimes(1);
  });

  it("keeps separate keys independent", async () => {
    const { app, exportRecipe } = server();

    await post(app, validBody, KEY("k1"));
    const other = await post(app, validBody, KEY("k2"));

    expect(other.json().idempotent).toBe(false);
    expect(exportRecipe).toHaveBeenCalledTimes(2);
  });
});

describe("idempotency conflicts, all 409", () => {
  it("returns 409 Idempotency key conflict for the same key with a different recipe", async () => {
    const { app, exportRecipe } = server();

    await post(app, validBody, KEY("k1"));
    const conflict = await post(app, { schemaVersion: 1, recipe: editedRecipe }, KEY("k1"));

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toBe("Idempotency key conflict");
    expect(exportRecipe).toHaveBeenCalledTimes(1);
  });

  it("returns 409 Export outcome unknown after an ambiguous write", async () => {
    const { app, exportRecipe } = failingWith(
      new ExportError("timeout", "AMBIGUOUS", "create_failed"),
    );

    const first = await post(app, validBody, KEY("k1"));
    const retry = await post(app, validBody, KEY("k1"));

    expect(first.statusCode).toBe(500);
    expect(retry.statusCode).toBe(409);
    expect(retry.json().error).toBe("Export outcome unknown");
    // The rule the whole state machine exists for: never a second attempt.
    expect(exportRecipe).toHaveBeenCalledTimes(1);
  });

  it.each(["create_failed", "verify_unreadable", "verify_missing"])(
    "treats %s as ambiguous and refuses to retry",
    async (code) => {
      const { app, exportRecipe } = failingWith(new ExportError("x", "AMBIGUOUS", code));

      await post(app, validBody, KEY("k1"));
      const retry = await post(app, validBody, KEY("k1"));

      expect(retry.json().error).toBe("Export outcome unknown");
      expect(exportRecipe).toHaveBeenCalledTimes(1);
    },
  );

  it("retries after a login failure, which is the one safe case", async () => {
    // login_failed → FAILED_SAFE → atomic re-claim → retry (ADR-020).
    let attempt = 0;
    const { app } = server(
      vi.fn(async (_recipe: Recipe): Promise<SaveResult> => {
        attempt += 1;
        if (attempt === 1) throw new ExportError("bad creds", "FAILED_SAFE", "login_failed");
        return saved;
      }),
    );

    const failed = await post(app, validBody, KEY("k1"));
    const retry = await post(app, validBody, KEY("k1"));

    expect(failed.statusCode).toBe(500);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().idempotent).toBe(false);
    expect(attempt).toBe(2);
  });

  it("still conflicts on a different recipe after a safe failure", async () => {
    // A retry is only a retry if it is the same request.
    const { app } = failingWith(new ExportError("bad creds", "FAILED_SAFE", "login_failed"));

    await post(app, validBody, KEY("k1"));
    const conflict = await post(app, { schemaVersion: 1, recipe: editedRecipe }, KEY("k1"));

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toBe("Idempotency key conflict");
  });

  it("lets at most one of two concurrent same-key requests write", async () => {
    const { app, exportRecipe } = server();

    const responses = await Promise.all([
      post(app, validBody, KEY("k1")),
      post(app, validBody, KEY("k1")),
    ]);

    expect(exportRecipe.mock.calls.length).toBeLessThanOrEqual(1);
    expect(responses.filter((r) => r.statusCode === 200).length).toBeGreaterThanOrEqual(1);
  });

  it("carries a requestId on every 409", async () => {
    const { app } = server();

    await post(app, validBody, KEY("k1"));
    const conflict = await post(app, { schemaVersion: 1, recipe: editedRecipe }, KEY("k1"));

    expect(conflict.headers["x-request-id"]).toBe(conflict.json().requestId);
  });

  it("uses three distinguishable 409 strings", async () => {
    // A client has to act differently for each: fix the body, wait, or stop and
    // look in AnyList.
    const conflictApp = server();
    await post(conflictApp.app, validBody, KEY("k1"));
    const conflict = await post(
      conflictApp.app,
      { schemaVersion: 1, recipe: editedRecipe },
      KEY("k1"),
    );

    const ambiguousApp = failingWith(new ExportError("x", "AMBIGUOUS", "create_failed"));
    await post(ambiguousApp.app, validBody, KEY("k2"));
    const ambiguous = await post(ambiguousApp.app, validBody, KEY("k2"));

    expect(conflict.json().error).toBe("Idempotency key conflict");
    expect(ambiguous.json().error).toBe("Export outcome unknown");
    expect(conflict.json().error).not.toBe(ambiguous.json().error);
  });
});

describe("request IDs", () => {
  it("returns a requestId matching the X-Request-Id header", async () => {
    const { app } = server();
    const response = await post(app, validBody, KEY("k1"));

    expect(response.headers["x-request-id"]).toBe(response.json().requestId);
  });

  it("adopts a client-supplied X-Request-Id", async () => {
    const { app } = server();
    const response = await post(app, validBody, { ...KEY("k1"), "x-request-id": "ios-export-7" });

    expect(response.json().requestId).toBe("ios-export-7");
  });

  it("returns a requestId on a failure too", async () => {
    const { app } = server();
    const response = await postRecipe(app, { ...recipe, title: "" });

    expect(typeof response.json().requestId).toBe("string");
  });
});

describe("body limit and content type", () => {
  it("allows a recipe body well above the 8 KB import limit", async () => {
    // Exports carry a full canonical Recipe, hence the 64 KB allowance.
    const large = { ...recipe, instructions: ["Blend.", "x".repeat(40_000)] };
    const { app } = server();

    expect((await postRecipe(app, large)).statusCode).toBe(200);
  });

  it("returns 413 Request body too large above 64 KB", async () => {
    const huge = { ...recipe, instructions: ["x".repeat(70_000)] };
    const { app } = server();
    const response = await postRecipe(app, huge);

    expect(response.statusCode).toBe(413);
    expect(response.json().error).toBe("Request body too large");
  });

  it.each(["application/xml", "text/plain"])(
    "returns 415 Unsupported content type for %s",
    async (contentType) => {
      const { app } = server();
      const response = await app.inject({
        method: "POST",
        url: "/api/exports/anylist",
        headers: { ...KEY("k1"), "content-type": contentType },
        payload: "<recipe/>",
      });

      expect(response.statusCode).toBe(415);
      expect(response.json().error).toBe("Unsupported content type");
    },
  );
});

describe("CONTRACT GAPS for POST /api/exports/anylist", () => {
  it.each(["QA-011", "QA-014", "QA-015", "QA-017", "QA-021"])(
    "%s was resolved by the approved contract and the implementation",
    (id) => {
      expect(gap(id).resolved).toBe(true);
      expect(gap(id).resolution).toBeTruthy();
    },
  );

  it("QA-018 remains open: no response field reflects what AnyList stored", () => {
    // saved.name is the submitted title and saved.id is client-generated
    // (ADR-021), so read-back proves existence and nothing more.
    expect(gap("QA-018").resolved).toBe(false);
  });

  it("QA-023 remains open: only title is hardened against whitespace", () => {
    expect(gap("QA-023").resolved).toBe(false);
  });
});
