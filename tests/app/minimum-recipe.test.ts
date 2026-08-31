import { describe, expect, it } from "vitest";

import { fixture } from "../../fixtures/corpus.js";
import { requireRecipe } from "../../fixtures/types.js";
import { isUsableRecipe } from "../../src/app/minimum-recipe.js";
import type { Ingredient, Recipe } from "../../src/recipe/schema.js";

/**
 * The minimum-usability gate (ADR-019, QA-025).
 *
 * The canonical schema's `min(1)` admits `"   "`, so a recipe can satisfy
 * "at least one ingredient" while holding nothing a person could read. These
 * assert the gate counts meaning rather than presence — and, just as
 * importantly, that it stays structural: no confidence threshold, and nothing
 * rewritten on the way through.
 */

const base = requireRecipe(fixture("tiktok-cottage-cheese-brownies"));

function ingredient(name: string): Ingredient {
  return { quantity: "1", unit: "cup", name, preparation: null, rawText: `1 cup ${name}`, alternateMeasurements: null };
}

function recipe(overrides: Partial<Recipe> = {}): Recipe {
  return { ...base, ...overrides };
}

describe("isUsableRecipe — accepts", () => {
  it("a normal valid recipe", () => {
    expect(isUsableRecipe(base)).toBe(true);
  });

  it("a low-confidence but structurally usable recipe", () => {
    // Explicitly not a confidence gate: 0 confidence with warnings still passes.
    const thin = recipe({ confidence: 0, warnings: ["thin source", "no servings stated"] });

    expect(isUsableRecipe(thin)).toBe(true);
  });

  it("a recipe whose ingredient has only a name", () => {
    const bare = recipe({
      ingredients: [{ quantity: null, unit: null, name: "salt", preparation: null, rawText: "salt", alternateMeasurements: null }],
    });

    expect(isUsableRecipe(bare)).toBe(true);
  });

  it("a mixture where at least one ingredient is meaningful", () => {
    const mixed = recipe({ ingredients: [ingredient("   "), ingredient("flour")] });

    expect(isUsableRecipe(mixed)).toBe(true);
  });

  it("a mixture where at least one instruction is meaningful", () => {
    const mixed = recipe({ instructions: ["   ", "Bake until set.", "\t"] });

    expect(isUsableRecipe(mixed)).toBe(true);
  });

  it("a title padded with whitespace around real text", () => {
    expect(isUsableRecipe(recipe({ title: "  Cottage Cheese Brownies  " }))).toBe(true);
  });
});

describe("isUsableRecipe — rejects", () => {
  it("a whitespace-only title", () => {
    expect(isUsableRecipe(recipe({ title: "   " }))).toBe(false);
  });

  it("a single whitespace-only ingredient name", () => {
    expect(isUsableRecipe(recipe({ ingredients: [ingredient("   ")] }))).toBe(false);
  });

  it("every ingredient name blank", () => {
    const blank = recipe({ ingredients: [ingredient("  "), ingredient("\t"), ingredient("\n")] });

    expect(isUsableRecipe(blank)).toBe(false);
  });

  it("a single whitespace-only instruction", () => {
    expect(isUsableRecipe(recipe({ instructions: ["   "] }))).toBe(false);
  });

  it("every instruction blank", () => {
    expect(isUsableRecipe(recipe({ instructions: ["  ", "\t", "\n"] }))).toBe(false);
  });

  it.each([
    ["tab", "\t"],
    ["newline", "\n"],
    ["carriage return", "\r"],
    ["non-breaking space", " "],
    ["mixed whitespace", " \t\n "],
  ])("a %s-only instruction", (_label, value) => {
    expect(isUsableRecipe(recipe({ instructions: [value] }))).toBe(false);
  });

  it("an empty ingredients array", () => {
    expect(isUsableRecipe(recipe({ ingredients: [] }))).toBe(false);
  });

  it("an empty instructions array", () => {
    expect(isUsableRecipe(recipe({ instructions: [] }))).toBe(false);
  });
});

describe("isUsableRecipe — inspects without rewriting", () => {
  it("leaves the recipe byte-for-byte unchanged", () => {
    const padded = recipe({
      title: "  Brownies  ",
      ingredients: [ingredient("  flour  ")],
      instructions: ["  Bake.  "],
    });
    const before = structuredClone(padded);

    expect(isUsableRecipe(padded)).toBe(true);
    expect(padded).toEqual(before);
  });

  it("does not require quantity, unit, preparation, or rawText to be meaningful", () => {
    // A nameless entry is unusable however well-quantified; those fields are
    // left entirely alone either way.
    const wellQuantifiedButNameless = recipe({
      ingredients: [
        { quantity: "2", unit: "cups", name: "  ", preparation: "sifted", rawText: "2 cups ???", alternateMeasurements: null },
      ],
    });

    expect(isUsableRecipe(wellQuantifiedButNameless)).toBe(false);
  });
});
