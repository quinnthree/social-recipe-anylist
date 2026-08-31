import { describe, expect, it } from "vitest";

import { EXPECTED_IDENTITIES } from "./constants.js";
import { CONVERTIBLE_UNITS, fromBase, toBase, UNIT_DEFINITIONS } from "./taxonomy.js";

describe("conversion constants", () => {
  it.each(EXPECTED_IDENTITIES.map((identity) => [identity[0], identity] as const))(
    "%s",
    (_label, [, left, right]) => {
      // Exact equality, not closeTo. These are defined values, not measured
      // ones, and a difference in the last bit means a typo rather than
      // floating-point drift.
      expect(left).toBe(right);
    },
  );

  it("derives every US volume from the gallon without accumulating error", () => {
    expect(toBase(1, "gallon")).toBe(toBase(4, "quart"));
    expect(toBase(1, "quart")).toBe(toBase(2, "pint"));
    expect(toBase(1, "pint")).toBe(toBase(2, "cup"));
    expect(toBase(1, "cup")).toBe(toBase(8, "fl_oz"));
    expect(toBase(1, "fl_oz")).toBe(toBase(2, "tbsp"));
    expect(toBase(1, "tbsp")).toBe(toBase(3, "tsp"));
  });

  it("round-trips every unit through its base", () => {
    for (const unit of CONVERTIBLE_UNITS) {
      expect(fromBase(toBase(7, unit), unit)).toBeCloseTo(7, 10);
    }
  });
});

describe("the unit taxonomy", () => {
  it("gives every unit a definition whose id matches its key", () => {
    for (const unit of CONVERTIBLE_UNITS) {
      expect(UNIT_DEFINITIONS[unit].id).toBe(unit);
    }
  });

  it("has a positive scale factor for every unit", () => {
    for (const unit of CONVERTIBLE_UNITS) {
      expect(UNIT_DEFINITIONS[unit].perBase).toBeGreaterThan(0);
    }
  });

  it("uses grams and millilitres as the two base units", () => {
    expect(UNIT_DEFINITIONS.g.perBase).toBe(1);
    expect(UNIT_DEFINITIONS.ml.perBase).toBe(1);
  });

  it("classifies every unit as exactly one of mass or volume", () => {
    for (const unit of CONVERTIBLE_UNITS) {
      expect(["mass", "volume"]).toContain(UNIT_DEFINITIONS[unit].kind);
    }
  });

  it("assigns every unit to metric or us, never neutral or unknown", () => {
    for (const unit of CONVERTIBLE_UNITS) {
      expect(["metric", "us"]).toContain(UNIT_DEFINITIONS[unit].system);
    }
  });

  it("renders fl_oz as 'fl oz' and everything else as its id", () => {
    expect(UNIT_DEFINITIONS.fl_oz.display).toBe("fl oz");

    for (const unit of CONVERTIBLE_UNITS) {
      if (unit === "fl_oz") continue;
      expect(UNIT_DEFINITIONS[unit].display).toBe(unit);
    }
  });

  it("covers the full required vocabulary", () => {
    expect([...CONVERTIBLE_UNITS].sort()).toEqual(
      [
        "cup",
        "fl_oz",
        "g",
        "gallon",
        "kg",
        "l",
        "lb",
        "mg",
        "ml",
        "oz",
        "pint",
        "quart",
        "tbsp",
        "tsp",
      ].sort(),
    );
  });
});
