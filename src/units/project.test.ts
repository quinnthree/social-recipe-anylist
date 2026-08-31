import { describe, expect, it } from "vitest";

import { project, type MeasuredInput, type TargetSystem } from "./project.js";

const alternate = (quantity: string, unit: string | null, descriptor: string | null = null) => ({
  quantity,
  unit,
  descriptor,
});

const ingredient = (
  quantity: string | null,
  unit: string | null,
  alternateMeasurements: ReturnType<typeof alternate>[] | null = null,
): MeasuredInput => ({ quantity, unit, alternateMeasurements });

const read = (input: MeasuredInput, target: TargetSystem) => {
  const projection = project(input, target);
  return `${projection.quantity ?? "∅"} ${projection.unit ?? "∅"}`.trim();
};

describe("Original mode changes nothing", () => {
  it("returns the canonical primary untouched", () => {
    const input = ingredient("400", "g", [alternate("14", "oz")]);
    const projection = project(input, "original");

    expect(projection.source).toBe("unchangedOriginal");
    expect(projection.reason).toBe("original_requested");
    expect(projection.quantity).toBe("400");
    expect(projection.unit).toBe("g");
  });

  it("keeps every author alternate available separately", () => {
    const input = ingredient("400", "g", [alternate("14", "oz"), alternate("2", null, "potatoes")]);

    expect(project(input, "original").secondaryAlternates).toHaveLength(2);
  });

  it("leaves an unconvertible ingredient alone too", () => {
    expect(read(ingredient(null, "to taste"), "original")).toBe("∅ to taste");
  });
});

describe("author-alternate precedence", () => {
  it("prefers the creator's own US mass alternate over a calculation", () => {
    const sweetPotatoes = ingredient("400", "g", [
      alternate("14", "oz"),
      alternate("2 to 2.5", null, "medium sweet potatoes"),
    ]);
    const projection = project(sweetPotatoes, "us");

    expect(projection.source).toBe("authorAlternate");
    expect(projection.quantity).toBe("14");
    expect(projection.unit).toBe("oz");
  });

  it("skips a same-system alternate from a different family", () => {
    // "1 cup sliced" is US, but it is a volume beside a mass. Selecting it
    // would be the cross-family swap done by hand instead of by arithmetic.
    const mushrooms = ingredient("100", "g", [alternate("3.5", "oz"), alternate("1", "cup", "sliced")]);
    const projection = project(mushrooms, "us");

    expect(projection.quantity).toBe("3.5");
    expect(projection.unit).toBe("oz");
  });

  it("keeps the unselected alternates as secondaries, in source order", () => {
    const parmesan = ingredient("30", "g", [alternate("1", "oz"), alternate("1/3", "cup", "grated")]);
    const projection = project(parmesan, "us");

    expect(projection.secondaryAlternates.map((a) => a.quantity)).toEqual(["1/3"]);
    expect(projection.secondaryAlternates[0]?.descriptor).toBe("grated");
  });

  it("takes the first qualifying alternate when several qualify", () => {
    const input = ingredient("500", "g", [alternate("17.6", "oz"), alternate("1.1", "lb")]);

    // Source order, never magnitude or unit preference. The creator wrote them
    // in an order and that order is information.
    expect(read(input, "us")).toBe("17.6 oz");
  });

  it("uses an alternate whose quantity could never be parsed arithmetically", () => {
    // The verbatim rule earns its keep here: "2 to 2.2" needs no parsing.
    const input = ingredient("1", "kg", [alternate("2 to 2.2", "lb")]);

    expect(read(input, "us")).toBe("2 to 2.2 lb");
  });

  it("never selects a unit-less descriptive alternate", () => {
    const input = ingredient("400", "g", [alternate("2 to 2.5", null, "medium sweet potatoes")]);
    const projection = project(input, "us");

    expect(projection.source).toBe("calculated");
    expect(projection.quantity).toBe("14.1");
  });

  it("ignores an alternate in the wrong system", () => {
    const input = ingredient("400", "g", [alternate("0.4", "kg")]);

    expect(project(input, "us").source).toBe("calculated");
  });

  it("carries the alternate's descriptor when it has one", () => {
    const input = ingredient("100", "ml", [alternate("3.4", "fl oz", "poured")]);
    const projection = project(input, "us");

    expect(projection.source).toBe("authorAlternate");
    expect(projection.descriptor).toBe("poured");
  });
});

describe("the creator's value is used verbatim", () => {
  const input = ingredient("400", "g", [alternate("14", "oz")]);

  it("is neither recalculated nor rounded", () => {
    // The exact conversion is 14.1096 oz. The creator said 14, so it stays 14.
    expect(project(input, "us").quantity).toBe("14");
  });

  it("keeps an odd quantity spelling exactly as written", () => {
    for (const written of ["1 1/2", "1½", "2 to 2.5", "0.50", "1.10"]) {
      const withAlternate = ingredient("1", "kg", [alternate(written, "lb")]);

      expect(project(withAlternate, "us").quantity).toBe(written);
    }
  });

  it("keeps the creator's unit spelling, not the canonical id", () => {
    const withPlural = ingredient("500", "ml", [alternate("2", "cups")]);

    expect(project(withPlural, "us").unit).toBe("cups");
    // The recognised unit is still reported, for callers that need it.
    expect(project(withPlural, "us").canonicalUnit).toBe("cup");
  });
});

describe("safe calculated conversion", () => {
  it.each([
    ["400 g → US", ingredient("400", "g"), "us", "14.1 oz"],
    ["250 g → US", ingredient("250", "g"), "us", "8.8 oz"],
    ["1 kg → US", ingredient("1", "kg"), "us", "2.2 lb"],
    ["1 1/2 lb → Metric", ingredient("1 1/2", "lb"), "metric", "680 g"],
    ["8 oz → Metric", ingredient("8", "oz"), "metric", "227 g"],
    ["240 ml → US", ingredient("240", "ml"), "us", "1 cup"],
    ["500 ml → US", ingredient("500", "ml"), "us", "2 1/8 cup"],
    ["1 cup → Metric", ingredient("1", "cup"), "metric", "237 ml"],
    ["1 tbsp → Metric", ingredient("1", "tbsp"), "metric", "15 ml"],
    ["1 tsp → Metric", ingredient("1", "tsp"), "metric", "5 ml"],
  ] as const)("%s", (_label, input, target, expected) => {
    expect(read(input, target)).toBe(expected);
  });

  it("reports the conversion as calculated, not as the creator's", () => {
    const projection = project(ingredient("400", "g"), "us");

    expect(projection.source).toBe("calculated");
    expect(projection.reason).toBe("calculated_conversion");
    expect(projection.descriptor).toBeNull();
  });

  it("rounds only after converting", () => {
    // Via grams, not via a rounded intermediate: 2 lb is 907.18474 g, and
    // rounding that first would give 907 g and then 31.99 oz.
    expect(read(ingredient("2", "lb"), "metric")).toBe("907 g");
  });

  it("converts a range across both endpoints", () => {
    expect(read(ingredient("2-3", "lb"), "metric")).toBe("907-1361 g");
    expect(read(ingredient("2 to 2.5", "kg"), "us")).toBe("4.41-5.51 lb");
  });

  it("renders a range in one unit, chosen by its lower end", () => {
    // The upper end alone would cross into pounds and produce "0.88-1.1 lb".
    expect(read(ingredient("400-500", "g"), "us")).toBe("14.1-17.6 oz");
  });
});

describe("the safe family rule", () => {
  const CROSS_FAMILY: ReadonlyArray<readonly [string, MeasuredInput, TargetSystem]> = [
    ["grams never become cups", ingredient("100", "g", [alternate("1", "cup")]), "us"],
    ["grams never become tablespoons", ingredient("15", "g", [alternate("1", "tbsp")]), "us"],
    ["millilitres never become grams", ingredient("240", "ml", [alternate("240", "g")]), "metric"],
    ["kilograms never become litres", ingredient("1", "kg", [alternate("1", "l")]), "metric"],
    ["a count never becomes a mass", ingredient("2", "cloves", [alternate("10", "g")]), "metric"],
  ];

  it.each(CROSS_FAMILY.map((entry) => [entry[0], entry] as const))(
    "%s",
    (_label, [, input, target]) => {
      const projection = project(input, target);

      // Either unchanged, or a calculation strictly inside the primary's own
      // family — never the cross-family alternate.
      expect(projection.source).not.toBe("authorAlternate");
    },
  );

  it("does not convert mass ounces into fluid ounces", () => {
    // Same word, different families. `8 oz` is already US and stays put.
    const projection = project(ingredient("8", "oz"), "us");

    expect(projection.kind).toBe("mass");
    expect(projection.unit).toBe("oz");
  });

  it("keeps mass and volume answers inside their own family", () => {
    expect(project(ingredient("400", "g"), "us").kind).toBe("mass");
    expect(project(ingredient("400", "ml"), "us").kind).toBe("volume");
  });
});

describe("already in the requested system", () => {
  it("leaves a US ingredient alone in US mode", () => {
    const projection = project(ingredient("14", "oz"), "us");

    expect(projection.source).toBe("unchangedOriginal");
    expect(projection.reason).toBe("already_in_target_system");
    expect(projection.quantity).toBe("14");
  });

  it("leaves a metric ingredient alone in Metric mode", () => {
    expect(project(ingredient("400", "g"), "metric").reason).toBe("already_in_target_system");
  });

  it("does not rewrite 14 oz into pounds merely because it could", () => {
    expect(read(ingredient("14", "oz"), "us")).toBe("14 oz");
    expect(read(ingredient("32", "oz"), "us")).toBe("32 oz");
  });

  it("beats the alternate search, so a US alternate cannot displace a US primary", () => {
    const input = ingredient("14", "oz", [alternate("1", "lb")]);

    expect(project(input, "us").source).toBe("unchangedOriginal");
  });
});

describe("unconvertible input fails closed", () => {
  it.each([
    ["a count", ingredient("2", "cloves"), "us", "kind_not_convertible"],
    ["a bare count", ingredient("4", null), "us", "kind_not_convertible"],
    ["a descriptive amount", ingredient(null, "to taste"), "us", "kind_not_convertible"],
    ["an unknown unit", ingredient("2", "smidgens"), "us", "unit_not_recognised"],
    // Metric, not US: "cups" is already US, and already-in-target would settle
    // it before the quantity was ever read.
    ["an unparseable quantity", ingredient("about two", "cups"), "metric", "quantity_not_parseable"],
  ] as const)("%s is left unchanged", (_label, input, target, reason) => {
    const projection = project(input, target);

    expect(projection.source).toBe("unchangedOriginal");
    expect(projection.reason).toBe(reason);
    expect(projection.quantity).toBe(input.quantity);
    expect(projection.unit).toBe(input.unit);
  });

  it("distinguishes why it declined", () => {
    // Same output, different diagnosis. A UI can say "we don't convert counts"
    // for one and nothing at all for the other.
    expect(project(ingredient("2", "cloves"), "us").kind).toBe("count");
    expect(project(ingredient("2", "smidgens"), "us").kind).toBe("unknown");
  });

  it("declines rather than reporting zero of something", () => {
    // 0.5 g is 0.0176 oz, which rounds to 0.0. Reporting "0 oz" would be worse
    // than saying nothing.
    const projection = project(ingredient("0.5", "g"), "us");

    expect(projection.source).toBe("unchangedOriginal");
    expect(projection.reason).toBe("no_representable_result");
    expect(projection.quantity).toBe("0.5");
  });

  it("is symmetric in both target systems", () => {
    for (const target of ["us", "metric"] as const) {
      expect(project(ingredient("2", "cloves"), target).source).toBe("unchangedOriginal");
    }
  });
});

describe("the projection is ephemeral, never canonical data", () => {
  it("does not mutate the ingredient it was given", () => {
    const alternates = [alternate("14", "oz")];
    const input = ingredient("400", "g", alternates);

    project(input, "us");

    expect(input).toEqual(ingredient("400", "g", [alternate("14", "oz")]));
    expect(alternates).toHaveLength(1);
  });

  it("never adds a calculated value to the alternates it reports", () => {
    // The calculated 14.1 oz must not appear among the creator's alternates.
    // Writing one there would destroy the only guarantee the field makes.
    const input = ingredient("400", "g", [alternate("2 to 2.5", null, "medium sweet potatoes")]);
    const projection = project(input, "us");

    expect(projection.quantity).toBe("14.1");
    expect(projection.secondaryAlternates).toEqual([
      {
        quantity: "2 to 2.5",
        unit: null,
        descriptor: "medium sweet potatoes",
        kind: "count",
        system: "neutral",
      },
    ]);
  });

  it("is a pure function of its inputs", () => {
    const input = ingredient("400", "g", [alternate("14", "oz")]);

    expect(project(input, "us")).toEqual(project(input, "us"));
  });
});
