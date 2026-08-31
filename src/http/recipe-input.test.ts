import { describe, expect, it } from "vitest";

import { recipeWith, validRecipe } from "../test-support/fixtures.js";
import { RecipeInputSchema } from "./recipe-input.js";

function parse(recipe: unknown): ReturnType<typeof RecipeInputSchema.safeParse> {
  return RecipeInputSchema.safeParse(recipe);
}

describe("RecipeInputSchema", () => {
  it("accepts a recipe our own extraction produced", () => {
    expect(parse(validRecipe).success).toBe(true);
  });

  it("accepts a recipe carrying extraction warnings", () => {
    // ADR-010: warnings are extraction-time history, never an export blocker.
    expect(parse(recipeWith({ warnings: ["a", "b", "c"], confidence: 0.1 })).success).toBe(true);
  });

  describe("semantic non-blank text (QA-023)", () => {
    it.each(["", "   ", "\t\n "])("rejects a blank title: %j", (title) => {
      expect(parse(recipeWith({ title })).success).toBe(false);
    });

    it("trims accepted text, so whitespace cannot change the fingerprint", () => {
      const result = parse(recipeWith({ title: "  Brownies  " }));

      expect(result.success && result.data.title).toBe("Brownies");
    });

    it("rejects a blank ingredient name", () => {
      const recipe = recipeWith({
        ingredients: [{ ...validRecipe.ingredients[0]!, name: "   " }],
      });

      expect(parse(recipe).success).toBe(false);
    });

    it("rejects a blank ingredient rawText", () => {
      const recipe = recipeWith({
        ingredients: [{ ...validRecipe.ingredients[0]!, rawText: " " }],
      });

      expect(parse(recipe).success).toBe(false);
    });

    it("rejects a blank instruction entry", () => {
      expect(parse(recipeWith({ instructions: ["Mix.", "  "] })).success).toBe(false);
    });

    it("preserves null as a meaningful 'not stated'", () => {
      const recipe = recipeWith({
        ingredients: [
          { quantity: null, unit: null, name: "salt", preparation: null, rawText: "salt", alternateMeasurements: null },
        ],
      });
      const result = parse(recipe);

      expect(result.success && result.data.ingredients[0]?.quantity).toBeNull();
    });

    it.each(["quantity", "unit", "preparation"] as const)(
      "rejects a whitespace-only %s, which carries no information",
      (field) => {
        const recipe = recipeWith({
          ingredients: [{ ...validRecipe.ingredients[0]!, [field]: "   " }],
        });

        expect(parse(recipe).success).toBe(false);
      },
    );
  });

  describe("source.url", () => {
    it.each(["http://example.com/p", "https://www.tiktok.com/@a/video/1"])(
      "accepts %s",
      (url) => {
        expect(parse(recipeWith({ source: { ...validRecipe.source, url } })).success).toBe(true);
      },
    );

    it.each([
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<script>",
      "ftp://example.com/x",
      "not a url",
    ])("rejects %s", (url) => {
      expect(parse(recipeWith({ source: { ...validRecipe.source, url } })).success).toBe(false);
    });
  });

  describe("TimeRange", () => {
    it("accepts the preferred exact-time form", () => {
      expect(parse(recipeWith({ cookTime: { minMinutes: 40, maxMinutes: null } })).success).toBe(
        true,
      );
    });

    it("accepts maxMinutes === minMinutes, which a client edit can produce", () => {
      expect(parse(recipeWith({ cookTime: { minMinutes: 40, maxMinutes: 40 } })).success).toBe(true);
    });

    it("rejects maxMinutes < minMinutes, which is not a range but a mistake", () => {
      expect(parse(recipeWith({ cookTime: { minMinutes: 40, maxMinutes: 20 } })).success).toBe(
        false,
      );
    });

    it("rejects a non-positive duration", () => {
      expect(parse(recipeWith({ cookTime: { minMinutes: 0, maxMinutes: null } })).success).toBe(
        false,
      );
    });
  });

  describe("strictness at every level", () => {
    it("rejects an unknown top-level key", () => {
      expect(parse({ ...validRecipe, extra: true }).success).toBe(false);
    });

    it("rejects an unknown key inside source", () => {
      expect(parse(recipeWith({ source: { ...validRecipe.source, extra: 1 } } as never)).success).toBe(
        false,
      );
    });

    it("rejects an unknown key inside an ingredient", () => {
      const recipe = recipeWith({
        ingredients: [{ ...validRecipe.ingredients[0]!, extra: 1 }],
      } as never);

      expect(parse(recipe).success).toBe(false);
    });

    it("rejects an unknown key inside a TimeRange", () => {
      const recipe = recipeWith({
        cookTime: { minMinutes: 10, maxMinutes: null, unit: "minutes" },
      } as never);

      expect(parse(recipe).success).toBe(false);
    });

    it("rejects an unknown platform", () => {
      const recipe = recipeWith({ source: { ...validRecipe.source, platform: "pinterest" } } as never);

      expect(parse(recipe).success).toBe(false);
    });

    it("accepts youtube, which is canonical even though ingestion is not built", () => {
      const recipe = recipeWith({
        source: { ...validRecipe.source, platform: "youtube", url: "https://www.youtube.com/watch?v=x" },
      });

      expect(parse(recipe).success).toBe(true);
    });
  });

  describe("bounds", () => {
    it("rejects a confidence outside 0..1", () => {
      expect(parse(recipeWith({ confidence: 1.5 })).success).toBe(false);
    });

    it("rejects fractional servings", () => {
      expect(parse(recipeWith({ servings: 2.5 })).success).toBe(false);
    });

    it("accepts an empty ingredient list, because the export path is not the acceptance gate", () => {
      // The minimum usable recipe applies to extraction (ADR-019). An export of
      // a user-edited recipe is validated for shape, not for cookability.
      expect(parse(recipeWith({ ingredients: [] })).success).toBe(true);
    });
  });
});
