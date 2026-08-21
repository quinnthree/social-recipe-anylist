import { describe, expect, it } from "vitest";

import { validRecipe } from "../test-support/fixtures.js";
import { canonicalise, fingerprintOf } from "./fingerprint.js";

describe("fingerprintOf", () => {
  it("is stable across object key ordering", () => {
    const a = { schemaVersion: 1, recipe: { title: "x", servings: 2 } };
    const b = { recipe: { servings: 2, title: "x" }, schemaVersion: 1 };

    // The whole reason for ADR-018: a client that re-serialises an identical
    // recipe must not get 409 Idempotency key conflict.
    expect(fingerprintOf(a)).toBe(fingerprintOf(b));
  });

  it("keeps array order significant, because reordering changes the recipe", () => {
    const ordered = { instructions: ["Mix.", "Bake."] };
    const reversed = { instructions: ["Bake.", "Mix."] };

    expect(fingerprintOf(ordered)).not.toBe(fingerprintOf(reversed));
  });

  it("distinguishes a changed value", () => {
    const changed = { ...validRecipe, servings: 4 };

    expect(fingerprintOf(validRecipe)).not.toBe(fingerprintOf(changed));
  });

  it("distinguishes null from a missing key", () => {
    expect(fingerprintOf({ a: 1, b: null })).not.toBe(fingerprintOf({ a: 1 }));
  });

  it("distinguishes a nested change deep in the recipe", () => {
    const edited = {
      ...validRecipe,
      ingredients: [{ ...validRecipe.ingredients[0]!, quantity: "8" }],
    };

    expect(fingerprintOf(validRecipe)).not.toBe(fingerprintOf(edited));
  });

  it("is a hex SHA-256", () => {
    expect(fingerprintOf(validRecipe)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("canonicalise", () => {
  it("sorts keys at every depth", () => {
    expect(canonicalise({ b: { d: 1, c: 2 }, a: 3 })).toBe('{"a":3,"b":{"c":2,"d":1}}');
  });

  it("does not confuse a string with the number that looks like it", () => {
    expect(canonicalise({ a: "1" })).not.toBe(canonicalise({ a: 1 }));
  });

  it("encodes undefined as null so an absent value cannot collide with a key", () => {
    expect(canonicalise({ a: undefined })).toBe('{"a":null}');
  });
});
