import { describe, expect, it } from "vitest";

import { classifyUnit, knownAliases, normaliseUnitText } from "./aliases.js";
import type { ConvertibleUnit } from "./taxonomy.js";

/** Every alias the milestone requires, by the unit it must resolve to. */
const REQUIRED: ReadonlyArray<readonly [ConvertibleUnit, readonly string[]]> = [
  ["g", ["g", "gram", "grams", "gr"]],
  ["kg", ["kg", "kilo", "kilos", "kilogram", "kilograms"]],
  ["oz", ["oz", "ounce", "ounces"]],
  ["lb", ["lb", "lbs", "pound", "pounds", "#"]],
  ["ml", ["ml", "milliliter", "milliliters", "millilitre", "millilitres", "cc"]],
  ["l", ["l", "liter", "liters", "litre", "litres"]],
  ["tsp", ["tsp", "tsp.", "teaspoon", "teaspoons"]],
  ["tbsp", ["tbsp", "tbsp.", "tbs", "tablespoon", "tablespoons"]],
  ["fl_oz", ["fl oz", "fl. oz.", "fluid ounce", "fluid ounces"]],
  ["cup", ["cup", "cups"]],
  ["pint", ["pint", "pints", "pt"]],
  ["quart", ["quart", "quarts", "qt"]],
  ["gallon", ["gallon", "gallons", "gal"]],
];

describe("every required alias resolves", () => {
  for (const [unit, aliases] of REQUIRED) {
    it.each(aliases)(`%s → ${unit}`, (alias) => {
      expect(classifyUnit(alias).unit).toBe(unit);
    });
  }
});

describe("normalisation", () => {
  it("is case-insensitive", () => {
    for (const written of ["G", "Gram", "GRAMS", "gRaMs"]) {
      expect(classifyUnit(written).unit).toBe("g");
    }
  });

  it("trims surrounding whitespace", () => {
    expect(classifyUnit("   cups   ").unit).toBe("cup");
  });

  it("tolerates abbreviation periods", () => {
    expect(classifyUnit("tsp.").unit).toBe("tsp");
    expect(classifyUnit("Tbsp.").unit).toBe("tbsp");
    expect(classifyUnit("fl. oz.").unit).toBe("fl_oz");
  });

  it("collapses internal whitespace", () => {
    expect(classifyUnit("fl    oz").unit).toBe("fl_oz");
    expect(classifyUnit("fluid  ounces").unit).toBe("fl_oz");
  });

  it("exposes the normalised key it looked up", () => {
    expect(normaliseUnitText("  FL. OZ.  ")).toBe("fl oz");
    expect(classifyUnit("  Tbsp. ").normalised).toBe("tbsp");
  });
});

describe("measurement-kind and system classification", () => {
  it.each([
    ["g", "mass", "metric"],
    ["kg", "mass", "metric"],
    ["mg", "mass", "metric"],
    ["oz", "mass", "us"],
    ["lb", "mass", "us"],
    ["ml", "volume", "metric"],
    ["l", "volume", "metric"],
    ["tsp", "volume", "us"],
    ["tbsp", "volume", "us"],
    ["fl oz", "volume", "us"],
    ["cup", "volume", "us"],
    ["pint", "volume", "us"],
    ["quart", "volume", "us"],
    ["gallon", "volume", "us"],
  ])("%s is %s / %s", (alias, kind, system) => {
    const classification = classifyUnit(alias);

    expect(classification.kind).toBe(kind);
    expect(classification.system).toBe(system);
  });

  it("treats a bare oz as mass, never as a fluid ounce", () => {
    // The V1 assumption, stated as a test so changing it is deliberate.
    expect(classifyUnit("oz").kind).toBe("mass");
    expect(classifyUnit("oz").unit).toBe("oz");
    expect(classifyUnit("fl oz").kind).toBe("volume");
  });

  it("classifies counting words as count, and never converts them", () => {
    for (const alias of ["clove", "cloves", "slices", "sprigs", "cans"]) {
      const classification = classifyUnit(alias);

      expect(classification.kind).toBe("count");
      expect(classification.system).toBe("neutral");
      expect(classification.unit).toBeNull();
    }
  });

  it("classifies amounts left to the cook as descriptive", () => {
    for (const alias of ["to taste", "pinch", "dash", "handful", "splash"]) {
      const classification = classifyUnit(alias);

      expect(classification.kind).toBe("descriptive");
      expect(classification.unit).toBeNull();
    }
  });

  it("reads a null unit as a bare count", () => {
    // "4" large eggs. Not an error, and not convertible either.
    expect(classifyUnit(null)).toEqual({
      unit: null,
      kind: "count",
      system: "neutral",
      normalised: "",
    });
  });
});

describe("unmatched units fail closed", () => {
  it.each(["smidgens", "glug-glug", "handfulls", "gramz", "ounzes", "cupp", "tblspn", "42", "!!"])(
    "%s is unknown",
    (alias) => {
      const classification = classifyUnit(alias);

      expect(classification.unit).toBeNull();
      expect(classification.kind).toBe("unknown");
      expect(classification.system).toBe("unknown");
    },
  );

  it("never guesses from fuzzy similarity", () => {
    // One character from a real alias in each case. A spell-correcting matcher
    // would accept all of these; the whole point is that this one does not.
    // `cups.` is deliberately absent — stripping abbreviation periods is a
    // documented normalisation, so it resolves, and correctly so.
    for (const near of ["gramss", "kgg", "ozz", "tsps", "litr", "tablespon"]) {
      expect(classifyUnit(near).kind).toBe("unknown");
    }
  });

  it("treats an empty or whitespace-only unit as unknown, not as a count", () => {
    // A null unit means the creator wrote none. An empty string means something
    // upstream produced junk, which is a different thing.
    expect(classifyUnit("").kind).toBe("unknown");
    expect(classifyUnit("   ").kind).toBe("unknown");
  });
});

describe("the alias table itself", () => {
  it("has no duplicate keys", () => {
    const aliases = knownAliases();

    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it("stores every key already normalised", () => {
    for (const alias of knownAliases()) {
      expect(normaliseUnitText(alias)).toBe(alias);
    }
  });

  it("resolves every key it contains", () => {
    for (const alias of knownAliases()) {
      expect(classifyUnit(alias).kind).not.toBe("unknown");
    }
  });
});
