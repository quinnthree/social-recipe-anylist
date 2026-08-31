import { describe, expect, it } from "vitest";

import type { Recipe } from "../../src/recipe/schema.js";

/**
 * Conformance for the APPROVED canonical input hardening (contracts.md
 * "Canonical input hardening", ADR-024).
 *
 * Scope matters here. This applies to **untrusted inbound consumer-API data**
 * only. ADR-024 is explicit that internal Zod objects are *not* required to be
 * globally strict, because that would cause churn across the extraction
 * pipeline for no safety gain. So this is a separate suite against a separate
 * schema — not an amendment to `RecipeSchema`.
 *
 * NOT IMPLEMENTED. Point this at the real inbound schema when it exists:
 *
 *   describe("inbound export body", () => runInboundRecipeConformance(accepts));
 */

/** Returns true when the value is accepted as a valid inbound export body. */
export type AcceptsExportBody = (value: unknown) => boolean;

/** A canonical Recipe used as the starting point for each mutation. */
export const VALID_INBOUND_RECIPE: Recipe = {
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
      alternateMeasurements: null,
    },
  ],
  instructions: ["Blend until smooth."],
  source: {
    platform: "tiktok",
    creator: "proteinbakes",
    url: "https://www.tiktok.com/@proteinbakes/video/7311111111111111111",
  },
  confidence: 0.9,
  warnings: [],
};

export function runInboundRecipeConformance(accepts: AcceptsExportBody): void {
  const body = (recipe: unknown) => ({ schemaVersion: 1, recipe });
  const withRecipe = (overrides: Record<string, unknown>) =>
    body({ ...VALID_INBOUND_RECIPE, ...overrides });

  describe("the baseline", () => {
    it("accepts a well-formed export body", () => {
      expect(accepts(body(VALID_INBOUND_RECIPE))).toBe(true);
    });

    it("accepts a recipe carrying extraction warnings", () => {
      // ADR-010: warnings are history, never a rejection reason.
      expect(
        accepts(withRecipe({ confidence: 0.2, warnings: ["No servings were stated."] })),
      ).toBe(true);
    });
  });

  describe("A. whitespace-only title", () => {
    it.each(["   ", "\t", "\n", "   "])("rejects a title of %j", (title) => {
      // min(1) alone admits "   ". Without this the recipe reaches AnyList
      // under a blank name.
      expect(accepts(withRecipe({ title }))).toBe(false);
    });

    it("still rejects an empty title", () => {
      expect(accepts(withRecipe({ title: "" }))).toBe(false);
    });

    it("accepts a title with surrounding whitespace around real content", () => {
      expect(accepts(withRecipe({ title: "  Brownies  " }))).toBe(true);
    });
  });

  describe("B. source.url scheme", () => {
    const withUrl = (url: string) =>
      withRecipe({ source: { ...VALID_INBOUND_RECIPE.source, url } });

    it.each([
      "https://www.tiktok.com/@a/video/1",
      "http://www.tiktok.com/@a/video/1",
    ])("accepts %s", (url) => {
      expect(accepts(withUrl(url))).toBe(true);
    });

    it.each([
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/plain,x",
      "ftp://host/x",
    ])("rejects %s", (url) => {
      // source.url is written straight into the AnyList recipe's sourceUrl. A
      // javascript: URL rendered as a link by any client that displays it is
      // the reason this is a boundary concern rather than a nicety.
      expect(accepts(withUrl(url))).toBe(false);
    });

    it("rejects a string that is not a URL at all", () => {
      expect(accepts(withUrl("not a url"))).toBe(false);
    });
  });

  describe("C. TimeRange bounds", () => {
    const withCookTime = (cookTime: unknown) => withRecipe({ cookTime });

    it("accepts the preferred exact form, maxMinutes null", () => {
      expect(accepts(withCookTime({ minMinutes: 40, maxMinutes: null }))).toBe(true);
    });

    it("accepts a genuine range", () => {
      expect(accepts(withCookTime({ minMinutes: 35, maxMinutes: 40 }))).toBe(true);
    });

    it("accepts maxMinutes === minMinutes", () => {
      // Explicitly permitted inbound by ADR-024, even though our own extraction
      // never emits it. See the rendering contradiction in
      // tests/contract/inbound-hardening.test.ts.
      expect(accepts(withCookTime({ minMinutes: 40, maxMinutes: 40 }))).toBe(true);
    });

    it("rejects maxMinutes < minMinutes", () => {
      expect(accepts(withCookTime({ minMinutes: 40, maxMinutes: 35 }))).toBe(false);
    });

    it("applies the same bound to prepTime", () => {
      expect(accepts(withRecipe({ prepTime: { minMinutes: 20, maxMinutes: 10 } }))).toBe(false);
      expect(accepts(withRecipe({ prepTime: { minMinutes: 20, maxMinutes: 20 } }))).toBe(true);
    });

    it("still rejects non-positive or fractional minutes", () => {
      for (const minMinutes of [0, -5, 12.5]) {
        expect(accepts(withCookTime({ minMinutes, maxMinutes: null }))).toBe(false);
      }
    });
  });

  describe("D. unknown fields are rejected, not ignored", () => {
    it("rejects an unknown key at the top level", () => {
      expect(accepts({ schemaVersion: 1, recipe: VALID_INBOUND_RECIPE, listId: "shopping" })).toBe(
        false,
      );
    });

    it("rejects an unknown key on the recipe", () => {
      expect(accepts(withRecipe({ nutritionScore: 8 }))).toBe(false);
    });

    it("rejects an unknown key on an ingredient", () => {
      expect(
        accepts(
          withRecipe({
            ingredients: [{ ...VALID_INBOUND_RECIPE.ingredients[0], optional: true }],
          }),
        ),
      ).toBe(false);
    });

    it("rejects an unknown key on source", () => {
      expect(
        accepts(withRecipe({ source: { ...VALID_INBOUND_RECIPE.source, verified: true } })),
      ).toBe(false);
    });

    it("rejects an unknown key on a time range", () => {
      expect(accepts(withRecipe({ cookTime: { minMinutes: 35, maxMinutes: 40, unit: "min" } }))).toBe(
        false,
      );
    });
  });

  /**
   * The one field where absence is deliberately not an error (B4-B).
   *
   * The backend ships before any iOS client knows `alternateMeasurements`
   * exists — server-first, by necessity. Every request arriving in that window
   * comes from a client whose ingredients simply have no such key, and section
   * D's strictness would reject all of them. So absence is accepted and
   * normalised to `null`; everything else about the field stays strict.
   */
  describe("E. alternateMeasurements is additive and optional inbound", () => {
    const ingredient = VALID_INBOUND_RECIPE.ingredients[0];
    const withIngredient = (overrides: Record<string, unknown>) =>
      withRecipe({ ingredients: [{ ...ingredient, ...overrides }] });

    const oldClientIngredient = (): Record<string, unknown> => {
      const copy: Record<string, unknown> = { ...ingredient };
      delete copy["alternateMeasurements"];
      return copy;
    };

    it("accepts an old client's ingredient, which omits the key entirely", () => {
      expect(accepts(withRecipe({ ingredients: [oldClientIngredient()] }))).toBe(true);
    });

    it("accepts an explicit null", () => {
      expect(accepts(withIngredient({ alternateMeasurements: null }))).toBe(true);
    });

    it("accepts an empty array", () => {
      expect(accepts(withIngredient({ alternateMeasurements: [] }))).toBe(true);
    });

    it("accepts author-provided alternates", () => {
      expect(
        accepts(
          withIngredient({
            alternateMeasurements: [
              { quantity: "14", unit: "oz", descriptor: null },
              { quantity: "2 to 2.5", unit: null, descriptor: "medium sweet potatoes" },
            ],
          }),
        ),
      ).toBe(true);
    });

    it("rejects a non-array, non-null value", () => {
      for (const value of ["14 oz", 14, {}, true]) {
        expect(accepts(withIngredient({ alternateMeasurements: value }))).toBe(false);
      }
    });

    it("rejects an alternate with no quantity", () => {
      for (const entry of [{ unit: "oz", descriptor: null }, { quantity: "", unit: "oz", descriptor: null }]) {
        expect(accepts(withIngredient({ alternateMeasurements: [entry] }))).toBe(false);
      }
    });

    it("rejects an alternate omitting unit or descriptor", () => {
      expect(accepts(withIngredient({ alternateMeasurements: [{ quantity: "14", unit: "oz" }] }))).toBe(
        false,
      );
      expect(
        accepts(withIngredient({ alternateMeasurements: [{ quantity: "14", descriptor: null }] })),
      ).toBe(false);
    });

    it("rejects an unknown key on an alternate", () => {
      expect(
        accepts(
          withIngredient({
            alternateMeasurements: [
              { quantity: "14", unit: "oz", descriptor: null, calculated: false },
            ],
          }),
        ),
      ).toBe(false);
    });

    it("rejects a blank unit or descriptor rather than coercing it to null", () => {
      expect(
        accepts(withIngredient({ alternateMeasurements: [{ quantity: "14", unit: "  ", descriptor: null }] })),
      ).toBe(false);
      expect(
        accepts(withIngredient({ alternateMeasurements: [{ quantity: "14", unit: "oz", descriptor: " " }] })),
      ).toBe(false);
    });
  });

  describe("schemaVersion", () => {
    it("requires schemaVersion 1", () => {
      expect(accepts({ recipe: VALID_INBOUND_RECIPE })).toBe(false);
      expect(accepts({ schemaVersion: "1", recipe: VALID_INBOUND_RECIPE })).toBe(false);
      expect(accepts({ schemaVersion: 1.5, recipe: VALID_INBOUND_RECIPE })).toBe(false);
    });
  });

  describe("everything the canonical contract already required still holds", () => {
    it.each(["title", "ingredients", "instructions", "source", "confidence", "warnings"])(
      "rejects a recipe with no %s",
      (field) => {
        const recipe: Record<string, unknown> = { ...VALID_INBOUND_RECIPE };
        delete recipe[field];

        expect(accepts(body(recipe))).toBe(false);
      },
    );

    it.each(["description", "servings", "prepTime", "cookTime"])(
      "still requires %s to be present as an explicit null",
      (field) => {
        const recipe: Record<string, unknown> = { ...VALID_INBOUND_RECIPE };
        delete recipe[field];

        expect(accepts(body(recipe))).toBe(false);
      },
    );

    it("rejects a platform outside the canonical set", () => {
      expect(accepts(withRecipe({ source: { ...VALID_INBOUND_RECIPE.source, platform: "pinterest" } }))).toBe(
        false,
      );
    });

    it("accepts youtube as a canonical platform", () => {
      expect(
        accepts(withRecipe({ source: { ...VALID_INBOUND_RECIPE.source, platform: "youtube" } })),
      ).toBe(true);
    });

    it("rejects a non-positive or fractional servings", () => {
      for (const servings of [0, -1, 2.5]) {
        expect(accepts(withRecipe({ servings }))).toBe(false);
      }
    });

    it("rejects confidence outside 0..1", () => {
      for (const confidence of [-0.1, 1.1, Number.NaN]) {
        expect(accepts(withRecipe({ confidence }))).toBe(false);
      }
    });

    it("rejects an empty instruction step", () => {
      expect(accepts(withRecipe({ instructions: ["Blend.", ""] }))).toBe(false);
    });

    it("accepts an empty ingredients array at the schema level", () => {
      // The minimum-usable-recipe rule (ADR-019) gates /api/imports output, not
      // inbound schema validity. An export of a recipe the user emptied is a
      // separate product question, not a schema one.
      expect(accepts(withRecipe({ ingredients: [] }))).toBe(true);
    });
  });
}
