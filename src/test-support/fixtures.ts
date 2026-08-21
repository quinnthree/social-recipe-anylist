import type { Recipe } from "../recipe/schema.js";
import type { SourceContent } from "../social/types.js";

/** Shared by the route tests so a contract change surfaces in one place. */

export const TEST_API_KEY = "test-api-key-2f8c1d";
export const TEST_URL = "https://www.tiktok.com/@creator/video/7123456789";

export const sourceContent: SourceContent = {
  platform: "tiktok",
  url: TEST_URL,
  creator: "creator",
  text: "Cottage cheese brownies. 16 oz cottage cheese. Blend until smooth. Bake 35-40 minutes.",
  textSource: "caption",
};

export const validRecipe: Recipe = {
  title: "Cottage Cheese Brownies",
  description: null,
  servings: 9,
  prepTime: null,
  cookTime: { minMinutes: 35, maxMinutes: 40 },
  ingredients: [
    {
      quantity: "16",
      unit: "oz",
      name: "cottage cheese",
      preparation: null,
      rawText: "16 oz cottage cheese",
    },
  ],
  instructions: ["Blend until smooth."],
  source: { platform: "tiktok", creator: "creator", url: TEST_URL },
  confidence: 0.9,
  warnings: ["No servings were stated in the source text."],
};

export function recipeWith(overrides: Partial<Recipe>): Recipe {
  return { ...validRecipe, ...overrides };
}

/** The wire body for `POST /api/exports/anylist`. */
export function exportBody(recipe: Recipe = validRecipe): Record<string, unknown> {
  return { schemaVersion: 1, recipe };
}

export function bearer(key: string = TEST_API_KEY): string {
  return `Bearer ${key}`;
}
