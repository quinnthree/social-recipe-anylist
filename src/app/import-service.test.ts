import { describe, expect, it, vi } from "vitest";

import { AnyListError, type RecipeSaver } from "../anylist/types.js";
import type { Recipe } from "../recipe/schema.js";
import type { SourceContent } from "../social/types.js";
import { ExtractionError } from "../social/types.js";
import { ImportError, importRecipe, type ImportDeps } from "./import-service.js";

const URL = "https://www.tiktok.com/@creator/video/7123456789";

const content: SourceContent = {
  platform: "tiktok",
  url: URL,
  creator: "creator",
  text: "Cottage cheese brownies",
  textSource: "caption",
};

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
  confidence: 1,
  warnings: [],
};

const saver: RecipeSaver = {
  save: async () => ({ name: recipe.title, identifier: "anylist-id" }),
};

function deps(overrides: Partial<ImportDeps> = {}): ImportDeps {
  return {
    fetchSourceContent: async () => content,
    parseRecipe: async () => recipe,
    createSaver: () => saver,
    ...overrides,
  };
}

describe("importRecipe", () => {
  it("extracts, saves, and reports the saved recipe", async () => {
    const result = await importRecipe(URL, { deps: deps() });

    expect(result.recipe).toEqual(recipe);
    expect(result.saved).toEqual({ name: "Cottage Cheese Brownies", identifier: "anylist-id" });
  });

  it("returns saved: null on a dry run and never constructs the saver", async () => {
    const createSaver = vi.fn(() => saver);
    const result = await importRecipe(URL, { dryRun: true, deps: deps({ createSaver }) });

    expect(result.recipe).toEqual(recipe);
    expect(result.saved).toBeNull();
    expect(createSaver).not.toHaveBeenCalled();
  });

  describe("failure classification", () => {
    const failingFetch = (error: unknown) =>
      deps({
        fetchSourceContent: async () => {
          throw error;
        },
      });

    it.each([
      ["invalid_url", "invalid_url"],
      ["unsupported_platform", "unsupported_platform"],
      ["source_unavailable", "extraction_failed"],
    ] as const)("maps ExtractionError code %s to kind %s", async (code, kind) => {
      const error = await importRecipe(URL, { deps: failingFetch(new ExtractionError("boom", code)) }).catch(
        (thrown: unknown) => thrown,
      );

      expect(error).toBeInstanceOf(ImportError);
      expect((error as ImportError).kind).toBe(kind);
    });

    it("classifies a parser failure as extraction_failed", async () => {
      const failing = deps({
        parseRecipe: async () => {
          throw new Error("The model did not return a parseable recipe");
        },
      });

      const error = await importRecipe(URL, { deps: failing }).catch((thrown: unknown) => thrown);

      expect((error as ImportError).kind).toBe("extraction_failed");
    });

    it("classifies an AnyList failure as save_failed", async () => {
      const failing = deps({
        createSaver: () => ({
          save: async () => {
            throw new AnyListError("Failed to save the recipe to AnyList.");
          },
        }),
      });

      const error = await importRecipe(URL, { deps: failing }).catch((thrown: unknown) => thrown);

      expect((error as ImportError).kind).toBe("save_failed");
    });

    it("classifies an unexpected save-path failure as internal", async () => {
      const failing = deps({
        createSaver: () => {
          throw new TypeError("something unexpected");
        },
      });

      const error = await importRecipe(URL, { deps: failing }).catch((thrown: unknown) => thrown);

      expect((error as ImportError).kind).toBe("internal");
    });

    it("does not classify by matching message text", async () => {
      // A message that looks like an invalid URL, but carries no code.
      const misleading = new Error('"nonsense" is not a valid URL.');
      const error = await importRecipe(URL, { deps: failingFetch(misleading) }).catch(
        (thrown: unknown) => thrown,
      );

      expect((error as ImportError).kind).toBe("extraction_failed");
    });

    it("preserves the original message for the CLI to print", async () => {
      const error = await importRecipe(URL, {
        deps: failingFetch(new ExtractionError("TikTok returned no caption text.", "source_unavailable")),
      }).catch((thrown: unknown) => thrown);

      expect((error as ImportError).message).toBe("TikTok returned no caption text.");
    });
  });
});
