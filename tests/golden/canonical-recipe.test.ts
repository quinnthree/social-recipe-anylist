import { describe, expect, it } from "vitest";

import { EXTRACTING_FIXTURES, fixture } from "../../fixtures/corpus.js";
import { expectedRecipe, requireRecipe } from "../../fixtures/types.js";
import { toAnyListRecipe } from "../../src/anylist/mapping.js";
import { RecipeSchema } from "../../src/recipe/schema.js";

/**
 * The golden canonical Recipe for each fixture, and what the AnyList export
 * adapter does to it. Everything here is deterministic: no model call, no
 * network, no AnyList.
 */

const recipeFor = (id: string) => requireRecipe(fixture(id));

describe("every golden recipe is a valid canonical Recipe", () => {
  it.each(EXTRACTING_FIXTURES.map((f) => [f.id, f] as const))("%s", (_id, entry) => {
    const recipe = expectedRecipe(entry);

    expect(RecipeSchema.safeParse(recipe).success).toBe(true);
  });

  it.each(EXTRACTING_FIXTURES.map((f) => [f.id, f] as const))(
    "%s survives a JSON round trip unchanged",
    (_id, entry) => {
      // What --dry-run prints and what the production API would return.
      const recipe = expectedRecipe(entry);

      expect(JSON.parse(JSON.stringify(recipe))).toEqual(recipe);
    },
  );

  it.each(EXTRACTING_FIXTURES.map((f) => [f.id, f] as const))(
    "%s states every optional field explicitly, never by omission",
    (_id, entry) => {
      const recipe = expectedRecipe(entry) as Record<string, unknown>;

      for (const field of ["description", "servings", "prepTime", "cookTime"]) {
        expect(Object.hasOwn(recipe, field)).toBe(true);
      }
    },
  );

  it.each(EXTRACTING_FIXTURES.map((f) => [f.id, f] as const))(
    "%s carries the original social URL as provenance",
    (_id, entry) => {
      expect(expectedRecipe(entry)?.source.url).toBe(entry.url);
    },
  );
});

describe("TimeRange semantics across the corpus", () => {
  it("encodes an exact stated time as minMinutes with maxMinutes null", () => {
    expect(recipeFor("tiktok-exact-cook-time").cookTime).toEqual({ minMinutes: 25, maxMinutes: null });
  });

  it("encodes a stated range across both bounds", () => {
    expect(recipeFor("tiktok-cook-time-range").cookTime).toEqual({ minMinutes: 90, maxMinutes: 120 });
  });

  it("never encodes an exact time as minMinutes === maxMinutes", () => {
    for (const entry of EXTRACTING_FIXTURES) {
      for (const time of [entry.expectedExtraction?.prepTime, entry.expectedExtraction?.cookTime]) {
        if (time == null) continue;
        expect(time.minMinutes).not.toBe(time.maxMinutes);
      }
    }
  });

  it("never has an upper bound below the lower bound", () => {
    for (const entry of EXTRACTING_FIXTURES) {
      for (const time of [entry.expectedExtraction?.prepTime, entry.expectedExtraction?.cookTime]) {
        if (time?.maxMinutes == null) continue;
        expect(time.maxMinutes).toBeGreaterThan(time.minMinutes);
      }
    }
  });

  it("leaves both times null when the source states neither", () => {
    const recipe = recipeFor("tiktok-ingredient-only-in-instructions");

    expect(recipe.prepTime).toBeNull();
    expect(recipe.cookTime).toBeNull();
  });
});

describe("the AnyList export adapter, over the golden corpus", () => {
  it.each(EXTRACTING_FIXTURES.map((f) => [f.id, f] as const))(
    "%s never transmits rawText, confidence, or warnings",
    (_id, entry) => {
      const recipe = expectedRecipe(entry);
      if (recipe === null) throw new Error("unreachable");

      const payload = JSON.stringify(toAnyListRecipe(recipe));

      expect(payload).not.toContain("rawText");
      expect(payload).not.toContain("confidence");
      expect(payload).not.toContain("warnings");
    },
  );

  it.each(EXTRACTING_FIXTURES.map((f) => [f.id, f] as const))(
    "%s maps every ingredient, dropping none",
    (_id, entry) => {
      const recipe = expectedRecipe(entry);
      if (recipe === null) throw new Error("unreachable");

      expect(toAnyListRecipe(recipe).ingredients).toHaveLength(recipe.ingredients.length);
    },
  );

  it("flattens a range to its lower bound and preserves the range in the note", () => {
    const mapped = toAnyListRecipe(recipeFor("tiktok-cook-time-range"));

    expect(mapped.cookTime).toBe(90);
    expect(mapped.note).toBe("Cook time stated in source: 90–120 minutes");
  });

  it("sends both stated times, and records both in the note", () => {
    const mapped = toAnyListRecipe(recipeFor("tiktok-chicken-tinga"));

    expect(mapped.prepTime).toBe(15);
    expect(mapped.cookTime).toBe(30);
    expect(mapped.note).toBe(
      "Prep time stated in source: 15 minutes\nCook time stated in source: 30 minutes",
    );
  });

  it("carries '(optional)' to AnyList only through the ingredient note", () => {
    // The canonical Ingredient has no optional flag. `preparation` is the only
    // field that reaches AnyList; `rawText`, which holds the literal
    // "(optional)", is dropped by the adapter. See docs/qa/findings.md QA-005.
    const recipe = recipeFor("tiktok-optional-ingredient");
    const mapped = toAnyListRecipe(recipe);
    const peanuts = mapped.ingredients.find((i) => i.name === "roasted peanuts");

    expect(peanuts).toEqual({ name: "roasted peanuts", quantity: "1/2 cup", note: "optional" });
    expect(JSON.stringify(mapped)).not.toContain("(optional)");
  });

  it("omits servings rather than inventing one when the source stated none", () => {
    const mapped = toAnyListRecipe(recipeFor("tiktok-missing-servings"));

    expect("servings" in mapped).toBe(false);
  });

  it("keeps an unquantified ingredient unquantified", () => {
    const mapped = toAnyListRecipe(recipeFor("tiktok-missing-quantity"));
    const salt = mapped.ingredients.find((i) => i.name === "flaky sea salt");

    expect(salt).toEqual({ name: "flaky sea salt" });
  });

  it("would happily export the login-page blurb as a recipe", () => {
    // Documents current behaviour, and why a confidence floor matters: an empty
    // recipe at confidence 0.1 maps to a perfectly well-formed AnyList payload.
    const mapped = toAnyListRecipe(recipeFor("instagram-login-blurb"));

    expect(mapped.name).toBe("Instagram Login Page");
    expect(mapped.ingredients).toEqual([]);
    expect(mapped.preparationSteps).toEqual([]);
  });
});
