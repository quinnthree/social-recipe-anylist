import { describe, expect, it } from "vitest";

import type { Ingredient, Recipe } from "../recipe/schema.js";
import { toAnyListIngredient, toAnyListRecipe } from "./mapping.js";

const SOURCE_URL = "https://www.tiktok.com/@creator/video/7123456789";

function recipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    title: "Cottage Cheese Brownies",
    description: null,
    servings: 9,
    prepTime: null,
    cookTime: null,
    ingredients: [
      {
        quantity: "16",
        unit: "oz",
        name: "cottage cheese",
        preparation: "blended",
        rawText: "16 oz cottage cheese, blended",
      },
    ],
    instructions: ["Blend until smooth.", "Bake until set."],
    source: { platform: "tiktok", creator: "creator", url: SOURCE_URL },
    confidence: 1,
    warnings: [],
    ...overrides,
  };
}

describe("toAnyListRecipe", () => {
  it("maps the core fields onto AnyList's names", () => {
    const mapped = toAnyListRecipe(recipe({ description: "Fudgy and high protein." }));

    expect(mapped.name).toBe("Cottage Cheese Brownies");
    expect(mapped.preparationSteps).toEqual(["Blend until smooth.", "Bake until set."]);
    expect(mapped.sourceName).toBe("creator");
    expect(mapped.note).toBe("Fudgy and high protein.");
  });

  it("preserves the original social URL verbatim as sourceUrl", () => {
    expect(toAnyListRecipe(recipe()).sourceUrl).toBe(SOURCE_URL);
  });

  it("converts servings losslessly to a string and invents no units", () => {
    const mapped = toAnyListRecipe(recipe({ servings: 9 }));

    expect(mapped.servings).toBe("9");
    expect(mapped.servings).not.toContain("serving");
  });

  it("omits servings entirely when none was stated", () => {
    const mapped = toAnyListRecipe(recipe({ servings: null }));

    expect(mapped.servings).toBeUndefined();
    expect("servings" in mapped).toBe(false);
  });

  it("omits sourceName when the creator is unknown", () => {
    const noCreator = recipe({
      source: { platform: "instagram", creator: null, url: SOURCE_URL },
    });
    const mapped = toAnyListRecipe(noCreator);

    expect(mapped.sourceName).toBeUndefined();
    expect("sourceName" in mapped).toBe(false);
    expect(mapped.sourceUrl).toBe(SOURCE_URL);
  });

  describe("time", () => {
    it("sends an exact time as minutes, not seconds", () => {
      const mapped = toAnyListRecipe(
        recipe({ cookTime: { minMinutes: 40, maxMinutes: null } }),
      );

      expect(mapped.cookTime).toBe(40);
      expect(mapped.cookTime).not.toBe(40 * 60);
    });

    it("records an exact time in the note, since the numeric field may persist as 0", () => {
      const mapped = toAnyListRecipe(
        recipe({ cookTime: { minMinutes: 40, maxMinutes: null } }),
      );

      expect(mapped.note).toBe("Cook time stated in source: 40 minutes");
    });

    it("sends the lower bound of a range and preserves the range in the note", () => {
      const mapped = toAnyListRecipe(
        recipe({ cookTime: { minMinutes: 35, maxMinutes: 40 } }),
      );

      expect(mapped.cookTime).toBe(35);
      expect(mapped.note).toBe("Cook time stated in source: 35–40 minutes");
    });

    it("never averages a range", () => {
      const mapped = toAnyListRecipe(
        recipe({ cookTime: { minMinutes: 30, maxMinutes: 60 } }),
      );

      expect(mapped.cookTime).toBe(30);
      expect(mapped.cookTime).not.toBe(45);
    });

    it("does the equivalent for an exact prep time", () => {
      const mapped = toAnyListRecipe(
        recipe({ prepTime: { minMinutes: 15, maxMinutes: null } }),
      );

      expect(mapped.prepTime).toBe(15);
      expect(mapped.note).toBe("Prep time stated in source: 15 minutes");
    });

    it("does the equivalent for a prep time range", () => {
      const mapped = toAnyListRecipe(
        recipe({ prepTime: { minMinutes: 20, maxMinutes: 25 } }),
      );

      expect(mapped.prepTime).toBe(20);
      expect(mapped.note).toBe("Prep time stated in source: 20–25 minutes");
    });

    it("omits both fields when no time was stated", () => {
      const mapped = toAnyListRecipe(recipe());

      expect(mapped.prepTime).toBeUndefined();
      expect(mapped.cookTime).toBeUndefined();
      expect("prepTime" in mapped).toBe(false);
      expect("cookTime" in mapped).toBe(false);
    });

    it("combines description and both time lines in order", () => {
      const mapped = toAnyListRecipe(
        recipe({
          description: "Fudgy and high protein.",
          prepTime: { minMinutes: 20, maxMinutes: 25 },
          cookTime: { minMinutes: 35, maxMinutes: 40 },
        }),
      );

      expect(mapped.note).toBe(
        "Fudgy and high protein.\n" +
          "Prep time stated in source: 20–25 minutes\n" +
          "Cook time stated in source: 35–40 minutes",
      );
    });

    it("mixes an exact prep time with a ranged cook time", () => {
      const mapped = toAnyListRecipe(
        recipe({
          prepTime: { minMinutes: 15, maxMinutes: null },
          cookTime: { minMinutes: 35, maxMinutes: 40 },
        }),
      );

      expect(mapped.prepTime).toBe(15);
      expect(mapped.cookTime).toBe(35);
      expect(mapped.note).toBe(
        "Prep time stated in source: 15 minutes\n" +
          "Cook time stated in source: 35–40 minutes",
      );
    });
  });

  describe("ingredients", () => {
    it("never drops an ingredient", () => {
      const many = recipe({
        ingredients: Array.from({ length: 12 }, (_unused, index) => ({
          quantity: null,
          unit: null,
          name: `ingredient ${index}`,
          preparation: null,
          rawText: `ingredient ${index}`,
        })),
      });

      expect(toAnyListRecipe(many).ingredients).toHaveLength(12);
    });

    it("keeps an ingredient that has nothing but a name", () => {
      const bare = recipe({
        ingredients: [
          { quantity: null, unit: null, name: "salt", preparation: null, rawText: "salt" },
        ],
      });

      expect(toAnyListRecipe(bare).ingredients).toEqual([{ name: "salt" }]);
    });
  });
});

describe("toAnyListIngredient", () => {
  const ingredient = (overrides: Partial<Ingredient> = {}): Ingredient => ({
    quantity: "1",
    unit: "cup",
    name: "flour",
    preparation: "sifted",
    rawText: "1 cup flour, sifted",
    ...overrides,
  });

  it("does not transmit rawText to AnyList", () => {
    const mapped = toAnyListIngredient(ingredient());

    expect(Object.keys(mapped).sort()).toEqual(["name", "note", "quantity"]);
    expect(JSON.stringify(mapped)).not.toContain("1 cup flour, sifted");
  });

  it("combines quantity and unit for display, and maps preparation to note", () => {
    const mapped = toAnyListIngredient(ingredient());

    expect(mapped.quantity).toBe("1 cup");
    expect(mapped.name).toBe("flour");
    expect(mapped.note).toBe("sifted");
  });

  it("keeps a unitless quantity", () => {
    expect(toAnyListIngredient(ingredient({ unit: null })).quantity).toBe("1");
  });

  it("omits quantity entirely when neither quantity nor unit is stated", () => {
    const mapped = toAnyListIngredient(ingredient({ quantity: null, unit: null }));
    expect(mapped.quantity).toBeUndefined();
  });

  it("keeps a V1 compound unit such as \"oz or 227g\" untouched", () => {
    const mapped = toAnyListIngredient(ingredient({ quantity: "8", unit: "oz or 227g" }));
    expect(mapped.quantity).toBe("8 oz or 227g");
  });

  it("omits note when no preparation was stated", () => {
    const mapped = toAnyListIngredient(ingredient({ preparation: null }));

    expect(mapped.note).toBeUndefined();
    expect("note" in mapped).toBe(false);
  });

  it("maps an ingredient with only a name to only a name", () => {
    const mapped = toAnyListIngredient(
      ingredient({ quantity: null, unit: null, preparation: null }),
    );
    expect(mapped).toEqual({ name: "flour" });
  });
});
