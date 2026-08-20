import { describe, expect, it, vi } from "vitest";

import { ImportError, type ImportResult } from "../app/import-service.js";
import type { Recipe } from "../recipe/schema.js";
import { buildServer } from "./server.js";

const API_KEY = "test-api-key-2f8c1d";
const URL = "https://www.tiktok.com/@creator/video/7123456789";

const recipe: Recipe = {
  title: "Cottage Cheese Brownies",
  description: null,
  servings: 9,
  prepTime: null,
  cookTime: { minMinutes: 35, maxMinutes: 40 },
  ingredients: [
    { quantity: "16", unit: "oz", name: "cottage cheese", preparation: null, rawText: "16 oz cottage cheese" },
  ],
  instructions: ["Blend until smooth."],
  source: { platform: "tiktok", creator: "creator", url: URL },
  confidence: 0.9,
  warnings: ["No servings were stated in the source text."],
};

const result: ImportResult = {
  recipe,
  saved: { name: recipe.title, identifier: "anylist-recipe-id-42" },
};

/** Never touches TikTok, Anthropic, or AnyList. */
function server(importRecipe = vi.fn(async () => result)) {
  return { app: buildServer({ apiKey: API_KEY, importRecipe }), importRecipe };
}

function post(app: ReturnType<typeof buildServer>, options: { auth?: string; payload?: unknown } = {}) {
  return app.inject({
    method: "POST",
    url: "/api/import",
    ...(options.auth === undefined ? {} : { headers: { authorization: options.auth } }),
    payload: options.payload ?? { url: URL },
  });
}

describe("buildServer", () => {
  it("refuses to start without an API key", () => {
    expect(() => buildServer({ apiKey: undefined })).toThrow("RECIPE_API_KEY is not set");
    expect(() => buildServer({ apiKey: "   " })).toThrow("RECIPE_API_KEY is not set");
  });
});

describe("GET /health", () => {
  it("reports ok without authentication", async () => {
    const { app } = server();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("does not touch the import pipeline", async () => {
    const { app, importRecipe } = server();
    await app.inject({ method: "GET", url: "/health" });

    expect(importRecipe).not.toHaveBeenCalled();
  });
});

describe("POST /api/import — authentication", () => {
  it("rejects a request with no Authorization header", async () => {
    const { app, importRecipe } = server();
    const response = await post(app);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ success: false, error: "Unauthorized" });
    expect(importRecipe).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong token", "Bearer wrong-key"],
    ["missing scheme", API_KEY],
    ["wrong scheme", `Basic ${API_KEY}`],
    ["empty token", "Bearer "],
    ["token with trailing text", `Bearer ${API_KEY}x`],
  ])("rejects %s", async (_label, auth) => {
    const { app, importRecipe } = server();
    const response = await post(app, { auth });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ success: false, error: "Unauthorized" });
    expect(importRecipe).not.toHaveBeenCalled();
  });

  it("never echoes the API key or the header back", async () => {
    const { app } = server();
    const response = await post(app, { auth: "Bearer wrong-key" });

    expect(response.body).not.toContain(API_KEY);
    expect(response.body).not.toContain("wrong-key");
  });
});

describe("POST /api/import — success", () => {
  it("returns the agreed response shape", async () => {
    const { app } = server();
    const response = await post(app, { auth: `Bearer ${API_KEY}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      success: true,
      recipe: {
        title: "Cottage Cheese Brownies",
        confidence: 0.9,
        warnings: ["No servings were stated in the source text."],
      },
      saved: { id: "anylist-recipe-id-42" },
    });
  });

  it("does not return the whole normalised Recipe", async () => {
    const { app } = server();
    const body = (await post(app, { auth: `Bearer ${API_KEY}` })).json();

    expect(body.recipe.ingredients).toBeUndefined();
    expect(body.recipe.instructions).toBeUndefined();
    expect(body.recipe.source).toBeUndefined();
  });

  it("passes the submitted URL to the import service", async () => {
    const { app, importRecipe } = server();
    await post(app, { auth: `Bearer ${API_KEY}` });

    expect(importRecipe).toHaveBeenCalledWith(URL);
  });
});

describe("POST /api/import — request validation", () => {
  it.each([
    ["a missing url", {}],
    ["a non-string url", { url: 42 }],
    ["a malformed url", { url: "not a url" }],
    ["an empty url", { url: "" }],
    ["unexpected extra keys", { url: URL, dryRun: true }],
  ])("rejects %s with 400", async (_label, payload) => {
    const { app, importRecipe } = server();
    const response = await post(app, { auth: `Bearer ${API_KEY}`, payload });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ success: false, error: "Invalid request body" });
    expect(importRecipe).not.toHaveBeenCalled();
  });
});

describe("POST /api/import — failure mapping", () => {
  const failing = (error: unknown) =>
    server(
      vi.fn(async () => {
        throw error;
      }),
    );

  it.each([
    ["invalid_url", 400, "Invalid recipe URL"],
    ["unsupported_platform", 400, "Unsupported platform"],
    ["extraction_failed", 422, "Recipe could not be extracted"],
    ["save_failed", 500, "Recipe import failed"],
    ["internal", 500, "Recipe import failed"],
  ] as const)("maps %s to %i", async (kind, status, message) => {
    const { app } = failing(new ImportError("some revealing internal detail", kind));
    const response = await post(app, { auth: `Bearer ${API_KEY}` });

    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ success: false, error: message });
  });

  it("returns a safe 500 for an unexpected throw", async () => {
    const { app } = failing(new Error("ENOTFOUND api.anthropic.com sk-ant-secret"));
    const response = await post(app, { auth: `Bearer ${API_KEY}` });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ success: false, error: "Recipe import failed" });
  });

  it("never leaks the underlying message, stack, or provider detail", async () => {
    const leaky = new ImportError(
      "AnyList login failed for cook@example.com with password hunter2",
      "save_failed",
    );
    const { app } = failing(leaky);
    const response = await post(app, { auth: `Bearer ${API_KEY}` });

    expect(response.body).not.toContain("cook@example.com");
    expect(response.body).not.toContain("hunter2");
    expect(response.body).not.toContain("AnyList");
    expect(response.body).not.toContain("at ");
  });
});

describe("unknown routes", () => {
  it("returns the standard envelope, not Fastify's default", async () => {
    const { app } = server();
    const response = await app.inject({ method: "GET", url: "/nope" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ success: false, error: "Not found" });
  });
});
