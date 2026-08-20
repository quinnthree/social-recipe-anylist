import { describe, expect, it } from "vitest";

import type { SourceContent } from "../social/types.js";
import { assessExtraction } from "./parser.js";
import { RecipeSchema, type ExtractedRecipe } from "./schema.js";

const completeExtraction: ExtractedRecipe = {
  title: "Chicken Tinga",
  description: "Smoky shredded chicken in chipotle tomato sauce.",
  servings: 4,
  prepTimeMinutes: 15,
  cookTimeMinutes: 30,
  ingredients: [
    { quantity: "2", unit: "lb", name: "chicken thighs", preparation: null, rawText: "2 lb chicken thighs" },
    { quantity: "1", unit: null, name: "white onion", preparation: "sliced", rawText: "1 white onion, sliced" },
  ],
  instructions: ["Simmer the chicken until tender.", "Shred and toss in the sauce."],
};

const captionSource: SourceContent = {
  platform: "tiktok",
  url: "https://www.tiktok.com/@creator/video/7123456789",
  creator: "creator",
  text: "x".repeat(400),
  textSource: "caption",
};

describe("RecipeSchema", () => {
  it("accepts a fully populated recipe", () => {
    const recipe = {
      ...completeExtraction,
      source: { platform: "tiktok", creator: "creator", url: captionSource.url },
      confidence: 0.95,
      warnings: [],
    };
    expect(RecipeSchema.parse(recipe).title).toBe("Chicken Tinga");
  });

  it("rejects confidence outside 0..1", () => {
    const recipe = {
      ...completeExtraction,
      source: { platform: "tiktok", creator: "creator", url: captionSource.url },
      confidence: 1.5,
      warnings: [],
    };
    expect(RecipeSchema.safeParse(recipe).success).toBe(false);
  });

  it("rejects an unsupported platform", () => {
    const recipe = {
      ...completeExtraction,
      source: { platform: "youtube", creator: null, url: "https://youtube.com/watch?v=abc" },
      confidence: 0.5,
      warnings: [],
    };
    expect(RecipeSchema.safeParse(recipe).success).toBe(false);
  });
});

describe("assessExtraction", () => {
  it("gives a complete caption-sourced recipe full confidence and no warnings", () => {
    const { confidence, warnings } = assessExtraction(completeExtraction, captionSource);
    expect(confidence).toBe(1);
    expect(warnings).toEqual([]);
  });

  it("penalises an empty extraction and explains why", () => {
    const empty: ExtractedRecipe = {
      ...completeExtraction,
      servings: null,
      prepTimeMinutes: null,
      cookTimeMinutes: null,
      ingredients: [],
      instructions: [],
    };
    const { confidence, warnings } = assessExtraction(empty, captionSource);

    expect(confidence).toBeCloseTo(0.2, 5);
    expect(warnings).toEqual([
      "No ingredients were found in the source text.",
      "No instructions were found in the source text.",
      "No servings were stated in the source text.",
      "No prep or cook time was stated in the source text.",
    ]);
  });

  it("flags Open Graph metadata, thin source text, and a missing creator", () => {
    const ogSource: SourceContent = {
      platform: "instagram",
      url: "https://www.instagram.com/reel/Cxyz123/",
      creator: null,
      text: "Chicken tinga, so good",
      textSource: "og-description",
    };
    const { confidence, warnings } = assessExtraction(completeExtraction, ogSource);

    expect(confidence).toBeCloseTo(0.8, 5);
    expect(warnings).toEqual([
      "Recipe was extracted from Open Graph metadata, which is often a truncated version of the caption.",
      "Source text was only 22 characters long.",
      "The source creator could not be determined.",
    ]);
  });

  it("never returns a confidence below zero", () => {
    const nothing: ExtractedRecipe = {
      title: "Unknown",
      description: null,
      servings: null,
      prepTimeMinutes: null,
      cookTimeMinutes: null,
      ingredients: [],
      instructions: [],
    };
    const thinOg: SourceContent = {
      platform: "instagram",
      url: "https://www.instagram.com/reel/Cxyz123/",
      creator: null,
      text: "short",
      textSource: "og-description",
    };
    expect(assessExtraction(nothing, thinOg).confidence).toBeGreaterThanOrEqual(0);
  });
});
