import { describe, expect, it } from "vitest";

import { EXTRACTING_FIXTURES, fixture } from "../../fixtures/corpus.js";
import { requireRecipe } from "../../fixtures/types.js";
import { toAnyListRecipe } from "../../src/anylist/mapping.js";
import { RecipeInputSchema } from "../../src/http/recipe-input.js";
import type { Ingredient } from "../../src/recipe/schema.js";

/**
 * The three promises B4-B makes about author-provided alternate measurements,
 * asserted over the golden corpus rather than over one hand-built object:
 *
 *   1. `rawText` is untouched, and remains the source ground truth.
 *   2. An alternate's descriptor is not a preparation.
 *   3. Nothing in the system invents an alternate.
 *
 * The fixture that matters most here is `instagram-sweet-potato-tart`, whose
 * caption is verbatim from a live extraction.
 */

const sweetPotato = requireRecipe(fixture("instagram-sweet-potato-tart"));
const usPrimary = requireRecipe(fixture("tiktok-us-primary-no-alternates"));

const ingredientNamed = (recipe: { ingredients: Ingredient[] }, name: string): Ingredient => {
  const found = recipe.ingredients.find((i) => i.name === name);
  if (found === undefined) throw new Error(`No ingredient named "${name}".`);
  return found;
};

describe("rawText remains the source ground truth", () => {
  it("keeps the creator's full parenthetical, alternates and all", () => {
    expect(ingredientNamed(sweetPotato, "Sweet potatoes").rawText).toBe(
      "Sweet potatoes — 400g (approx. 14 oz / 2 to 2.5 medium sweet potatoes)",
    );
  });

  it.each(EXTRACTING_FIXTURES.map((f) => [f.id, f] as const))(
    "%s: every rawText appears verbatim in the source text",
    (_id, entry) => {
      // The strongest available statement that rawText is a quotation rather
      // than a reconstruction: it must be findable, character for character, in
      // the text the adapter actually fetched.
      const recipe = requireRecipe(entry);
      const source = entry.expectedSourceContent?.text ?? "";

      for (const ingredient of recipe.ingredients) {
        expect(source).toContain(ingredient.rawText);
      }
    },
  );

  it("is never regenerated from the structured fields", () => {
    // If rawText were rebuilt from quantity/unit/name, this line would read
    // "400 g Sweet potatoes" and the creator's equivalents would be gone.
    const potatoes = ingredientNamed(sweetPotato, "Sweet potatoes");
    const reconstructed = [potatoes.quantity, potatoes.unit, potatoes.name].join(" ");

    expect(potatoes.rawText).not.toBe(reconstructed);
    expect(potatoes.rawText).toContain("approx. 14 oz");
  });

  it("survives the inbound export contract unchanged", () => {
    // A recipe that made the round trip out to a client and back must still
    // carry the original line, not a normalised version of it.
    const parsed = RecipeInputSchema.parse(sweetPotato);

    expect(parsed.ingredients.map((i) => i.rawText)).toEqual(
      sweetPotato.ingredients.map((i) => i.rawText),
    );
  });

  it("is still withheld from AnyList", () => {
    // Unchanged from before B4-B, and worth re-asserting now that rawText is
    // the only place some of this information exists.
    const payload = JSON.stringify(toAnyListRecipe(sweetPotato));

    expect(payload).not.toContain("rawText");
    expect(payload).not.toContain("approx.");
  });
});

describe("the preparation boundary", () => {
  it.each([
    ["Mushrooms", "sliced"],
    ["Red Peppers", "diced"],
    ["Parmesan", "grated"],
  ])(
    "%s: '%s' stays on the alternate and does not become a preparation",
    (name, descriptor) => {
      const ingredient = ingredientNamed(sweetPotato, name);

      // The cut word qualifies the creator's volume measurement — it says what
      // a cup of this ingredient means — rather than instructing the cook.
      expect(ingredient.preparation).toBeNull();
      expect(ingredient.alternateMeasurements?.map((a) => a.descriptor)).toContain(descriptor);
    },
  );

  it("keeps an unambiguous ingredient preparation in preparation", () => {
    // The boundary cuts both ways: "2 cloves garlic, minced" states a
    // preparation of the ingredient itself, and that still belongs there.
    const garlic = ingredientNamed(usPrimary, "garlic");

    expect(garlic.preparation).toBe("minced");
    expect(garlic.alternateMeasurements).toBeNull();
  });

  it("does not resolve the leading-adjective case either way (QA-028)", () => {
    // "3/4 cup grated parmesan" is genuinely ambiguous — the adjective may be
    // part of the ingredient's identity or a preparation of it — and B4-B does
    // not decide. The corpus records the current behaviour so a later change is
    // visible as a change.
    const parmesan = ingredientNamed(usPrimary, "grated parmesan");

    expect(parmesan.preparation).toBeNull();
  });
});

describe("nothing invents an alternate", () => {
  it("leaves a US-primary recipe with no alternates at all", () => {
    // Every quantity here is trivially convertible, and none is converted.
    for (const ingredient of usPrimary.ingredients) {
      expect(ingredient.alternateMeasurements).toBeNull();
    }
  });

  it("records no alternate for an ingredient the creator stated once", () => {
    expect(ingredientNamed(sweetPotato, "Large eggs").alternateMeasurements).toBeNull();
    expect(ingredientNamed(sweetPotato, "Salt, Paprika & Pepper").alternateMeasurements).toBeNull();
  });

  it.each(EXTRACTING_FIXTURES.map((f) => [f.id, f] as const))(
    "%s: every alternate's quantity and unit appear in the source line",
    (_id, entry) => {
      // A calculated value would not be quotable from the creator's own text.
      // This is what makes "never a conversion" checkable rather than a promise
      // in a prompt.
      for (const ingredient of requireRecipe(entry).ingredients) {
        for (const alternate of ingredient.alternateMeasurements ?? []) {
          expect(ingredient.rawText).toContain(alternate.quantity);
          if (alternate.unit !== null) expect(ingredient.rawText).toContain(alternate.unit);
          if (alternate.descriptor !== null) {
            expect(ingredient.rawText).toContain(alternate.descriptor);
          }
        }
      }
    },
  );

  it.each(EXTRACTING_FIXTURES.map((f) => [f.id, f] as const))(
    "%s: no alternate is an empty array",
    (_id, entry) => {
      // "The creator offered none" is null. An empty array is a third way of
      // saying the same thing, and our own extraction never produces it.
      for (const ingredient of requireRecipe(entry).ingredients) {
        expect(ingredient.alternateMeasurements).not.toEqual([]);
      }
    },
  );

  it("preserves a source quantity as written rather than normalising it", () => {
    // "2 to 2.5" is not turned into a range object, two numbers, or "2-2.5".
    const potatoes = ingredientNamed(sweetPotato, "Sweet potatoes");

    expect(potatoes.alternateMeasurements?.[1]).toEqual({
      quantity: "2 to 2.5",
      unit: null,
      descriptor: "medium sweet potatoes",
    });
  });

  it("preserves Unicode vulgar fractions in the primary quantity", () => {
    expect(ingredientNamed(usPrimary, "long grain rice").quantity).toBe("1½");
    expect(ingredientNamed(usPrimary, "grated parmesan").quantity).toBe("¾");
    expect(ingredientNamed(usPrimary, "heavy cream").quantity).toBe("½");
  });
});
