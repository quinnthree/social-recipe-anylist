import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { fixture } from "../../fixtures/corpus.js";
import { requireRecipe } from "../../fixtures/types.js";
import { ImportError } from "../../src/app/import-service.js";
import { buildServer } from "../../src/http/server.js";
import { RecipeSchema, type Recipe } from "../../src/recipe/schema.js";
import { gap } from "./contract-gaps.js";

/**
 * POST /api/imports — extraction only. Independent verification against the
 * approved contract (contracts.md Part 2 §A, "Schema versioning",
 * "Request IDs", "Minimum usable recipe").
 *
 * Implemented and activated 2026-08-21. Every assertion traces to a clause;
 * where the contract does not say, the CONTRACT GAPS block records that rather
 * than guessing.
 *
 * `extractRecipe` is injected, so nothing here reaches TikTok or Anthropic.
 */

const API_KEY = "test-api-key-2f8c1d";
const AUTH = { authorization: `Bearer ${API_KEY}` };

const golden = fixture("tiktok-cottage-cheese-brownies");
const recipe = requireRecipe(golden);

const validBody = { schemaVersion: 1, url: golden.url };

/** The extraction dependency, injected. Never touches the network. */
function server(
  extractRecipe = vi.fn(async (_url: string, _options?: unknown): Promise<Recipe> => recipe),
) {
  return { app: buildServer({ apiKey: API_KEY, extractRecipe }), extractRecipe };
}

function failingWith(error: unknown) {
  return server(
    vi.fn(async (_url: string, _options?: unknown): Promise<Recipe> => {
      throw error;
    }),
  );
}

function post(
  app: FastifyInstance,
  payload: Record<string, unknown>,
  headers: Record<string, string> = AUTH,
): Promise<LightMyRequestResponse> {
  return app.inject({ method: "POST", url: "/api/imports", headers, payload });
}

describe("authentication", () => {
  it("rejects a missing bearer token", async () => {
    const { app, extractRecipe } = server();
    const response = await app.inject({ method: "POST", url: "/api/imports", payload: validBody });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe("Unauthorized");
    expect(extractRecipe).not.toHaveBeenCalled();
  });

  it("rejects a wrong bearer token", async () => {
    const { app } = server();
    const response = await post(app, validBody, { authorization: "Bearer wrong" });

    expect(response.statusCode).toBe(401);
  });
});

describe("schemaVersion", () => {
  it("accepts version 1 and echoes it on success", async () => {
    const { app } = server();
    const response = await post(app, validBody);

    expect(response.statusCode).toBe(200);
    expect(response.json().schemaVersion).toBe(1);
  });

  it.each([
    ["missing", { url: golden.url }],
    ["null", { schemaVersion: null, url: golden.url }],
    ["a string", { schemaVersion: "1", url: golden.url }],
    ["non-integer", { schemaVersion: 1.5, url: golden.url }],
  ])("rejects a %s schemaVersion with 400 Invalid request body", async (_label, payload) => {
    const { app, extractRecipe } = server();
    const response = await post(app, payload);

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("Invalid request body");
    expect(extractRecipe).not.toHaveBeenCalled();
  });

  it("rejects a recognised-but-unsupported version distinctly", async () => {
    // A separate string from "Invalid request body", so a client can tell a
    // version mismatch from a malformed body and act differently.
    const { app } = server();
    const response = await post(app, { schemaVersion: 2, url: golden.url });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("Unsupported schema version");
  });
});

describe("strict body validation", () => {
  it("rejects an unknown key rather than ignoring it", async () => {
    // ADR-011: a client must never believe the server honoured a field it
    // silently dropped.
    const { app } = server();
    const response = await post(app, { ...validBody, dryRun: true });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("Invalid request body");
  });

  it.each([
    ["a missing url", { schemaVersion: 1 }],
    ["a non-string url", { schemaVersion: 1, url: 42 }],
    ["a malformed url", { schemaVersion: 1, url: "not a url" }],
    ["an empty url", { schemaVersion: 1, url: "" }],
  ])("rejects %s", async (_label, payload) => {
    const { app } = server();

    expect((await post(app, payload)).statusCode).toBe(400);
  });
});

describe("extraction only", () => {
  it("returns the complete canonical Recipe, not the summary /api/import returns", async () => {
    const { app } = server();
    const body = (await post(app, validBody)).json();

    expect(RecipeSchema.safeParse(body.recipe).success).toBe(true);
    expect(body.recipe).toEqual(recipe);
  });

  it("returns every field the review screen needs", async () => {
    const { app } = server();
    const body = (await post(app, validBody)).json();

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
    // The reason the endpoint exists (ADR-007): Review/Edit happens before
    // anything is committed.
    const { app } = server();
    const body = (await post(app, validBody)).json();

    expect(body.saved).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("anylist");
  });

  it("preserves source provenance exactly as extracted", async () => {
    const { app } = server();
    const body = (await post(app, validBody)).json();

    expect(body.recipe.source).toEqual({
      platform: "tiktok",
      creator: golden.expectedSourceContent?.creator,
      url: golden.url,
    });
  });

  it("passes the submitted URL to extraction untouched", async () => {
    const { app, extractRecipe } = server();
    const url = "https://www.tiktok.com/@a/video/1?is_from_webapp=1";
    await post(app, { schemaVersion: 1, url });

    expect(extractRecipe.mock.calls[0]?.[0]).toBe(url);
  });
});

describe("minimum usable recipe (ADR-019)", () => {
  // The gate itself lives at the import-service boundary and is verified in
  // tests/failure-modes/pipeline-failures.test.ts. Here the concern is only
  // that the endpoint reports it as a safe 422 rather than leaking it.
  it("reports an unusable extraction as 422", async () => {
    const { app } = failingWith(
      new ImportError("The extracted recipe is not usable", "extraction_failed"),
    );
    const response = await post(app, validBody);

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe("Recipe could not be extracted");
  });

  it("does NOT reject a low-confidence recipe that meets the minimum", async () => {
    // ADR-019 is explicit that confidence takes no part in the decision.
    const lowConfidence: Recipe = { ...recipe, confidence: 0.1, warnings: ["thin source"] };
    const { app } = server(vi.fn(async (_url: string) => lowConfidence));
    const response = await post(app, validBody);

    expect(response.statusCode).toBe(200);
    expect(response.json().recipe.confidence).toBe(0.1);
  });

  it("does NOT reject a recipe merely for carrying warnings", async () => {
    const warned: Recipe = { ...recipe, warnings: ["No servings were stated in the source text."] };
    const { app } = server(vi.fn(async (_url: string) => warned));
    const response = await post(app, validBody);

    expect(response.statusCode).toBe(200);
    expect(response.json().recipe.warnings).toHaveLength(1);
  });

  it("returns confidence and warnings untouched, gate or no gate", async () => {
    const { app } = server();
    const body = (await post(app, validBody)).json();

    expect(body.recipe.confidence).toBe(recipe.confidence);
    expect(body.recipe.warnings).toEqual(recipe.warnings);
  });
});

describe("request IDs", () => {
  it("returns a requestId matching the X-Request-Id header", async () => {
    const { app } = server();
    const response = await post(app, validBody);

    expect(typeof response.json().requestId).toBe("string");
    expect(response.headers["x-request-id"]).toBe(response.json().requestId);
  });

  it("adopts a client-supplied X-Request-Id rather than generating one", async () => {
    const { app } = server();
    const response = await post(app, validBody, { ...AUTH, "x-request-id": "shortcut-run-42" });

    expect(response.json().requestId).toBe("shortcut-run-42");
    expect(response.headers["x-request-id"]).toBe("shortcut-run-42");
  });

  it("returns a requestId on failures too", async () => {
    const { app } = server();
    const response = await post(app, { schemaVersion: 1, url: "not a url" });

    expect(typeof response.json().requestId).toBe("string");
    expect(response.headers["x-request-id"]).toBe(response.json().requestId);
  });

  it("issues a different id per request when the client supplies none", async () => {
    const { app } = server();

    const first = await post(app, validBody);
    const second = await post(app, validBody);

    expect(first.json().requestId).not.toBe(second.json().requestId);
  });
});

describe("safe failures", () => {
  it.each([
    ["invalid_url", 400, "Invalid recipe URL"],
    ["unsupported_platform", 400, "Unsupported platform"],
    ["extraction_failed", 422, "Recipe could not be extracted"],
    ["save_failed", 500, "Recipe import failed"],
    ["internal", 500, "Recipe import failed"],
  ] as const)("maps %s to %i", async (kind, status, error) => {
    const { app } = failingWith(new ImportError("revealing internal detail", kind));
    const response = await post(app, validBody);

    expect(response.statusCode).toBe(status);
    expect(response.json().error).toBe(error);
  });

  it("returns a safe 500 for an unexpected throw", async () => {
    const { app } = failingWith(new Error("ENOTFOUND api.anthropic.com sk-ant-secret"));
    const response = await post(app, validBody);

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("sk-ant-secret");
  });

  it("never echoes an underlying message, stack, or provider detail", async () => {
    const { app } = failingWith(
      new ImportError("AnyList login failed for cook@example.com with password hunter2", "internal"),
    );
    const response = await post(app, validBody);

    expect(response.body).not.toContain("cook@example.com");
    expect(response.body).not.toContain("hunter2");
    expect(response.body).not.toContain("    at ");
  });

  it("carries success, error, and requestId, and nothing else", async () => {
    const { app } = server();
    const response = await post(app, { schemaVersion: 1, url: "not a url" });

    expect(Object.keys(response.json()).sort()).toEqual(["error", "requestId", "success"]);
  });
});

describe("no durable idempotency on this endpoint", () => {
  it("succeeds without an Idempotency-Key", async () => {
    // ADR-017: only POST /api/exports/anylist requires it. This endpoint is
    // read/compute-only and performs no external write.
    const { app } = server();

    expect((await post(app, validBody)).statusCode).toBe(200);
  });

  it("does not report an idempotent or originalRequestId field", async () => {
    const { app } = server();
    const body = (await post(app, validBody)).json();

    expect(body.idempotent).toBeUndefined();
    expect(body.originalRequestId).toBeUndefined();
  });

  it("re-extracts for a repeated identical request", async () => {
    // No dedup, deliberately: repeating an extraction costs a model call but
    // creates nothing, so there is nothing to make idempotent.
    const { app, extractRecipe } = server();

    await post(app, validBody);
    await post(app, validBody);

    expect(extractRecipe).toHaveBeenCalledTimes(2);
  });

  it("ignores an Idempotency-Key if one is supplied", async () => {
    const { app } = server();
    const response = await post(app, validBody, { ...AUTH, "idempotency-key": "k1" });

    expect(response.statusCode).toBe(200);
    expect(response.json().idempotent).toBeUndefined();
  });
});

describe("body limit and content type", () => {
  it("returns 413 Request body too large above 8 KB", async () => {
    const { app } = server();
    const response = await post(app, {
      schemaVersion: 1,
      url: `https://www.tiktok.com/${"a".repeat(9000)}`,
    });

    expect(response.statusCode).toBe(413);
    expect(response.json().error).toBe("Request body too large");
  });

  it("accepts a body just under the limit", async () => {
    const { app } = server();
    const response = await post(app, {
      schemaVersion: 1,
      url: `https://www.tiktok.com/${"a".repeat(7000)}`,
    });

    expect(response.statusCode).toBe(200);
  });

  it.each(["application/xml", "text/plain", "application/octet-stream"])(
    "returns 415 Unsupported content type for %s",
    async (contentType) => {
      const { app } = server();
      const response = await app.inject({
        method: "POST",
        url: "/api/imports",
        headers: { ...AUTH, "content-type": contentType },
        payload: "<import/>",
      });

      expect(response.statusCode).toBe(415);
      expect(response.json().error).toBe("Unsupported content type");
    },
  );

  it("carries a requestId on a 413 and a 415", async () => {
    const { app } = server();

    const tooLarge = await post(app, {
      schemaVersion: 1,
      url: `https://www.tiktok.com/${"a".repeat(9000)}`,
    });
    const wrongType = await app.inject({
      method: "POST",
      url: "/api/imports",
      headers: { ...AUTH, "content-type": "application/xml" },
      payload: "<import/>",
    });

    expect(tooLarge.json().requestId).toBe(tooLarge.headers["x-request-id"]);
    expect(wrongType.json().requestId).toBe(wrongType.headers["x-request-id"]);
  });
});

describe("CONTRACT GAPS for POST /api/imports", () => {
  it("QA-013 remains open: the server-issued recipe identity question", () => {
    // contracts.md §A still marks this unresolved, pending a decision on
    // persistence. The implemented response carries `recipe` and no identity
    // field, which is the no-persistence reading — asserted above by the
    // response key-set test. If persistence lands, that changes.
    expect(gap("QA-013").resolved).toBe(false);
  });
});
