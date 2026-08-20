import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { describe, expect, it } from "vitest";

import type { SourceContent } from "../social/types.js";
import { assessExtraction } from "./parser.js";
import {
  ExtractedRecipeSchema,
  RecipeSchema,
  TimeRangeSchema,
  type ExtractedRecipe,
} from "./schema.js";

const completeExtraction: ExtractedRecipe = {
  title: "Chicken Tinga",
  description: "Smoky shredded chicken in chipotle tomato sauce.",
  servings: 4,
  prepTime: { minMinutes: 15, maxMinutes: null },
  cookTime: { minMinutes: 30, maxMinutes: null },
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

describe("TimeRangeSchema", () => {
  it("accepts an exact stated time as minMinutes with a null maxMinutes", () => {
    expect(TimeRangeSchema.parse({ minMinutes: 40, maxMinutes: null })).toEqual({
      minMinutes: 40,
      maxMinutes: null,
    });
  });

  it("accepts a stated range across both bounds", () => {
    expect(TimeRangeSchema.parse({ minMinutes: 35, maxMinutes: 40 })).toEqual({
      minMinutes: 35,
      maxMinutes: 40,
    });
  });

  it("requires positive integers", () => {
    expect(TimeRangeSchema.safeParse({ minMinutes: 0, maxMinutes: null }).success).toBe(false);
    expect(TimeRangeSchema.safeParse({ minMinutes: -5, maxMinutes: null }).success).toBe(false);
    expect(TimeRangeSchema.safeParse({ minMinutes: 12.5, maxMinutes: null }).success).toBe(false);
  });

  it("requires maxMinutes to be present, even when null", () => {
    expect(TimeRangeSchema.safeParse({ minMinutes: 40 }).success).toBe(false);
  });

  it("accepts an absent time as null on the recipe", () => {
    const recipe = {
      ...completeExtraction,
      prepTime: null,
      cookTime: null,
      source: { platform: "tiktok", creator: "creator", url: captionSource.url },
      confidence: 0.5,
      warnings: [],
    };
    const parsed = RecipeSchema.parse(recipe);
    expect(parsed.prepTime).toBeNull();
    expect(parsed.cookTime).toBeNull();
  });
});

describe("structured output format", () => {
  it("serialises to JSON Schema so the extraction call cannot fail at runtime", () => {
    // Guards against a future schema addition (e.g. a .refine()) that Zod
    // cannot express as JSON Schema — that would only surface on a live import.
    const format = zodOutputFormat(ExtractedRecipeSchema) as { schema: Record<string, unknown> };
    const properties = format.schema["properties"] as Record<string, unknown>;

    expect(properties["cookTime"]).toBeDefined();
    expect(properties["prepTime"]).toBeDefined();
    expect(JSON.stringify(format.schema)).toContain("minMinutes");
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
      prepTime: null,
      cookTime: null,
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

  it("does not claim a time was absent when a duration survives in the instructions", () => {
    const timedInInstructions: ExtractedRecipe = {
      ...completeExtraction,
      prepTime: null,
      cookTime: null,
      instructions: ["Bake at 350\u00b0F (175\u00b0C) for 35\u201340 minutes.", "Rest before slicing."],
    };
    const { warnings } = assessExtraction(timedInInstructions, captionSource);

    expect(warnings).toContain(
      "A duration appears in the recipe text but was not captured as a structured prep or cook time.",
    );
    expect(warnings).not.toContain("No prep or cook time was stated in the source text.");
  });

  it.each([
    ["a plain duration", "Simmer for 20 minutes."],
    ["an abbreviated unit", "Rest 10 mins."],
    ["an hour", "Chill for 1 hour."],
    ["a 'to' range", "Fry 2 to 3 minutes per side."],
    ["an em-dash range", "Bake 35\u201440 minutes."],
    ["a duration in the description", null],
  ])("detects %s", (_label, instruction) => {
    const extracted: ExtractedRecipe = {
      ...completeExtraction,
      description: instruction === null ? "Ready in 45 minutes." : completeExtraction.description,
      prepTime: null,
      cookTime: null,
      instructions: instruction === null ? ["Mix and serve."] : [instruction],
    };
    expect(assessExtraction(extracted, captionSource).warnings).not.toContain(
      "No prep or cook time was stated in the source text.",
    );
  });

  it.each([
    ["an oven temperature", "Bake at 350\u00b0F (175\u00b0C) until golden."],
    ["a count of items", "Add 2 medium onions and 3 slices of bacon."],
    ["a weight", "Stir in 8 oz cream cheese."],
  ])("does not mistake %s for a duration", (_label, instruction) => {
    const extracted: ExtractedRecipe = {
      ...completeExtraction,
      description: null,
      prepTime: null,
      cookTime: null,
      instructions: [instruction],
    };
    expect(assessExtraction(extracted, captionSource).warnings).toContain(
      "No prep or cook time was stated in the source text.",
    );
  });

  it("still reports a missing time when the extraction has no duration anywhere", () => {
    const untimed: ExtractedRecipe = {
      ...completeExtraction,
      description: null,
      prepTime: null,
      cookTime: null,
      instructions: ["Simmer the chicken until tender.", "Shred and toss in the sauce."],
    };
    expect(assessExtraction(untimed, captionSource).warnings).toContain(
      "No prep or cook time was stated in the source text.",
    );
  });

  it("does not warn about a missing time when an exact cook time was captured", () => {
    const exact: ExtractedRecipe = {
      ...completeExtraction,
      prepTime: null,
      cookTime: { minMinutes: 40, maxMinutes: null },
      instructions: ["Bake for 40 minutes."],
    };
    const { warnings } = assessExtraction(exact, captionSource);

    expect(warnings).not.toContain("No prep or cook time was stated in the source text.");
    expect(warnings).not.toContain(
      "A duration appears in the recipe text but was not captured as a structured prep or cook time.",
    );
  });

  it("does not warn about a missing time when a cook time range was captured", () => {
    const ranged: ExtractedRecipe = {
      ...completeExtraction,
      prepTime: null,
      cookTime: { minMinutes: 35, maxMinutes: 40 },
      instructions: ["Bake at 350\u00b0F for 35\u201340 minutes."],
    };
    expect(assessExtraction(ranged, captionSource).warnings).toEqual([]);
  });

  it("keeps a step-specific duration in the instruction without promoting it to a time", () => {
    // "saute for 5 minutes" is not the recipe's stated prep or cook duration,
    // so both time fields stay null and mentionsDuration flags the mismatch.
    const stepDuration: ExtractedRecipe = {
      ...completeExtraction,
      prepTime: null,
      cookTime: null,
      instructions: ["Saut\u00e9 the onion for 5 minutes.", "Add the chicken and stir."],
    };
    const { warnings } = assessExtraction(stepDuration, captionSource);

    expect(warnings).toContain(
      "A duration appears in the recipe text but was not captured as a structured prep or cook time.",
    );
    expect(warnings).not.toContain("No prep or cook time was stated in the source text.");
  });

  it("handles the Cottage Cheese Brownie 35-40 minute case end to end", () => {
    const brownies: ExtractedRecipe = {
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
      instructions: ["Blend until smooth.", "Bake at 350\u00b0F (175\u00b0C) for 35\u201340 minutes."],
    };
    const { confidence, warnings } = assessExtraction(brownies, captionSource);

    expect(brownies.cookTime).toEqual({ minMinutes: 35, maxMinutes: 40 });
    expect(warnings).not.toContain("No prep or cook time was stated in the source text.");
    expect(warnings).not.toContain(
      "A duration appears in the recipe text but was not captured as a structured prep or cook time.",
    );
    expect(confidence).toBe(1);
  });

  it("never returns a confidence below zero", () => {
    const nothing: ExtractedRecipe = {
      title: "Unknown",
      description: null,
      servings: null,
      prepTime: null,
      cookTime: null,
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
