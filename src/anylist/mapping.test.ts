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
        alternateMeasurements: null,
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
    // AnyList stores these as seconds; the canonical model carries minutes.
    // Confirmed on a physical device on 2026-08-28, where a canonical 120
    // minutes displayed as "2 min" — the raw minute value read as seconds.
    // A `getRecipeById` round trip agreed with itself and told us nothing,
    // which is why the earlier assertion here was confidently wrong.
    it("converts an exact time from minutes to seconds", () => {
      const mapped = toAnyListRecipe(
        recipe({ cookTime: { minMinutes: 40, maxMinutes: null } }),
      );

      expect(mapped.cookTime).toBe(2400);
      expect(mapped.cookTime).not.toBe(40);
    });

    it.each([
      ["prepTime", 2, 120],
      ["prepTime", 120, 7200],
      ["cookTime", 40, 2400],
      ["cookTime", 1, 60],
    ] as const)("sends %s of %i minutes as %i seconds", (field, minutes, seconds) => {
      const mapped = toAnyListRecipe(recipe({ [field]: { minMinutes: minutes, maxMinutes: null } }));

      expect(mapped[field]).toBe(seconds);
    });

    it("leaves the note in minutes, because that is what a person reads", () => {
      const mapped = toAnyListRecipe(recipe({ prepTime: { minMinutes: 120, maxMinutes: null } }));

      expect(mapped.prepTime).toBe(7200);
      expect(mapped.note).toBe("Prep time stated in source: 120 minutes");
    });

    it("records an exact time in the note as well as the numeric field", () => {
      const mapped = toAnyListRecipe(
        recipe({ cookTime: { minMinutes: 40, maxMinutes: null } }),
      );

      expect(mapped.note).toBe("Cook time stated in source: 40 minutes");
    });

    it("sends the lower bound of a range and preserves the range in the note", () => {
      const mapped = toAnyListRecipe(
        recipe({ cookTime: { minMinutes: 35, maxMinutes: 40 } }),
      );

      expect(mapped.cookTime).toBe(2100);
      expect(mapped.note).toBe("Cook time stated in source: 35–40 minutes");
    });

    describe("an exact time, in both forms the contract admits", () => {
      // Our own extraction produces maxMinutes: null, and that stays preferred.
      // A client may legitimately send maxMinutes === minMinutes instead, and
      // "40–40 minutes" must never reach a user's recipe note.
      it("renders maxMinutes: null as a single time", () => {
        const mapped = toAnyListRecipe(recipe({ cookTime: { minMinutes: 40, maxMinutes: null } }));

        expect(mapped.note).toBe("Cook time stated in source: 40 minutes");
        expect(mapped.cookTime).toBe(2400);
      });

      it("renders maxMinutes === minMinutes as the same single time", () => {
        const mapped = toAnyListRecipe(recipe({ cookTime: { minMinutes: 40, maxMinutes: 40 } }));

        expect(mapped.note).toBe("Cook time stated in source: 40 minutes");
        expect(mapped.note).not.toContain("40–40");
        expect(mapped.cookTime).toBe(2400);
      });

      it("still renders a genuine range as a range", () => {
        const mapped = toAnyListRecipe(recipe({ cookTime: { minMinutes: 35, maxMinutes: 40 } }));

        expect(mapped.note).toBe("Cook time stated in source: 35–40 minutes");
        expect(mapped.cookTime).toBe(2100);
      });

      // TimeRangeSchema does not order the bounds, so an inverted pair is
      // structurally admissible. Rendering it as "40–20 minutes" would be worse
      // than dropping the bound that was never a range in the first place.
      it("does not render an inverted pair as a range", () => {
        const mapped = toAnyListRecipe(recipe({ cookTime: { minMinutes: 40, maxMinutes: 20 } }));

        expect(mapped.note).toBe("Cook time stated in source: 40 minutes");
      });

      it("applies the same rule to prep time", () => {
        const mapped = toAnyListRecipe(recipe({ prepTime: { minMinutes: 15, maxMinutes: 15 } }));

        expect(mapped.note).toBe("Prep time stated in source: 15 minutes");
        expect(mapped.prepTime).toBe(900);
      });
    });

    it("never averages a range", () => {
      const mapped = toAnyListRecipe(
        recipe({ cookTime: { minMinutes: 30, maxMinutes: 60 } }),
      );

      // The lower bound, converted — never the midpoint, converted or otherwise.
      expect(mapped.cookTime).toBe(1800);
      expect(mapped.cookTime).not.toBe(45 * 60);
    });

    it("does the equivalent for an exact prep time", () => {
      const mapped = toAnyListRecipe(
        recipe({ prepTime: { minMinutes: 15, maxMinutes: null } }),
      );

      expect(mapped.prepTime).toBe(900);
      expect(mapped.note).toBe("Prep time stated in source: 15 minutes");
    });

    it("does the equivalent for a prep time range", () => {
      const mapped = toAnyListRecipe(
        recipe({ prepTime: { minMinutes: 20, maxMinutes: 25 } }),
      );

      expect(mapped.prepTime).toBe(1200);
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

      expect(mapped.prepTime).toBe(900);
      expect(mapped.cookTime).toBe(2100);
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
          alternateMeasurements: null,
        })),
      });

      expect(toAnyListRecipe(many).ingredients).toHaveLength(12);
    });

    it("keeps an ingredient that has nothing but a name", () => {
      const bare = recipe({
        ingredients: [
          { quantity: null, unit: null, name: "salt", preparation: null, rawText: "salt", alternateMeasurements: null },
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
    alternateMeasurements: null,
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

/**
 * B4-B added `alternateMeasurements` to the canonical Ingredient and changed
 * nothing about what AnyList receives.
 *
 * That is the milestone's actual decision, so it is asserted rather than
 * assumed. AnyList has one quantity string per ingredient; appending the
 * creator's equivalents to it would rewrite the user's ingredient line as a
 * side effect of a schema change nobody asked to see. The alternates are being
 * preserved for a later Review projection, and until that exists they stay out
 * of the export.
 */
describe("author-provided alternates never reach AnyList", () => {
  const sweetPotato: Ingredient = {
    quantity: "400",
    unit: "g",
    name: "Sweet potatoes",
    preparation: null,
    rawText: "Sweet potatoes — 400g (approx. 14 oz / 2 to 2.5 medium sweet potatoes)",
    alternateMeasurements: [
      { quantity: "14", unit: "oz", descriptor: null },
      { quantity: "2 to 2.5", unit: null, descriptor: "medium sweet potatoes" },
    ],
  };

  const withoutAlternates: Ingredient = { ...sweetPotato, alternateMeasurements: null };

  it("maps identically with and without alternates", () => {
    expect(toAnyListIngredient(sweetPotato)).toEqual(toAnyListIngredient(withoutAlternates));
  });

  it("sends the primary measurement alone", () => {
    expect(toAnyListIngredient(sweetPotato)).toEqual({ name: "Sweet potatoes", quantity: "400 g" });
  });

  it("leaks no alternate text into the payload", () => {
    const payload = JSON.stringify(toAnyListRecipe(recipe({ ingredients: [sweetPotato] })));

    for (const leaked of ["alternateMeasurements", "14", "oz", "2 to 2.5", "medium sweet potatoes", "approx"]) {
      expect(payload).not.toContain(leaked);
    }
  });

  it("does not promote an alternate descriptor into the AnyList note", () => {
    // "sliced" qualifies the creator's cup measurement. Writing it into the
    // note would tell the cook to slice something the creator never asked them
    // to slice.
    const mushrooms: Ingredient = {
      quantity: "100",
      unit: "g",
      name: "Mushrooms",
      preparation: null,
      rawText: "Mushrooms — 100g (approx. 3.5 oz / 1 cup sliced)",
      alternateMeasurements: [
        { quantity: "3.5", unit: "oz", descriptor: null },
        { quantity: "1", unit: "cup", descriptor: "sliced" },
      ],
    };

    expect(toAnyListIngredient(mushrooms)).toEqual({ name: "Mushrooms", quantity: "100 g" });
  });

  it("still sends a real preparation alongside alternates", () => {
    // Suppressing the descriptor must not suppress `preparation` too.
    const garlic: Ingredient = {
      quantity: "2",
      unit: "cloves",
      name: "garlic",
      preparation: "minced",
      rawText: "2 cloves garlic, minced (about 1 tsp)",
      alternateMeasurements: [{ quantity: "1", unit: "tsp", descriptor: null }],
    };

    expect(toAnyListIngredient(garlic)).toEqual({
      name: "garlic",
      quantity: "2 cloves",
      note: "minced",
    });
  });
});
