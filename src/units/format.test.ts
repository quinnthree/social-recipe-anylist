import { describe, expect, it } from "vitest";

import { displayUnit, formatMass, formatQuantityInUnit, formatVolume } from "./format.js";

const mass = (grams: number, system: "metric" | "us") => {
  const formatted = formatMass(grams, system);
  return formatted === null ? null : `${formatted.quantity} ${displayUnit(formatted.unit)}`;
};

const volume = (millilitres: number, system: "metric" | "us") => {
  const formatted = formatVolume(millilitres, system);
  return formatted === null ? null : `${formatted.quantity} ${displayUnit(formatted.unit)}`;
};

describe("metric mass", () => {
  it.each([
    [400, "400 g"],
    [999, "999 g"],
    [999.4, "999 g"],
    [1000, "1 kg"],
    [1500, "1.5 kg"],
    [2267.96, "2.27 kg"],
  ])("%d g → %s", (grams, expected) => {
    expect(mass(grams, "metric")).toBe(expected);
  });

  it("keeps one decimal below 10 g, where it still means something", () => {
    expect(mass(7.5, "metric")).toBe("7.5 g");
    expect(mass(2.3, "metric")).toBe("2.3 g");
  });

  it("emits whole grams at and above 10 g", () => {
    expect(mass(226.796, "metric")).toBe("227 g");
    expect(mass(10.4, "metric")).toBe("10 g");
  });

  it("switches to kilograms exactly at 1000 g", () => {
    expect(mass(999.9, "metric")).toBe("1000 g");
    expect(mass(1000, "metric")).toBe("1 kg");
  });
});

describe("US mass", () => {
  it.each([
    [400, "14.1 oz"],
    [250, "8.8 oz"],
    [28.349523125, "1 oz"],
    [453.59237, "1 lb"],
    [1000, "2.2 lb"],
  ])("%d g → %s", (grams, expected) => {
    expect(mass(grams, "us")).toBe(expected);
  });

  it("switches to pounds exactly at 16 oz", () => {
    expect(mass(453.59237 - 0.1, "us")).toBe("16 oz");
    expect(mass(453.59237, "us")).toBe("1 lb");
  });

  it("never emits a long decimal pound", () => {
    // The exact value is 2.2046226 lb.
    expect(mass(1000, "us")).toBe("2.2 lb");
  });

  it("declines rather than rounding a tiny mass to zero", () => {
    expect(mass(0.5, "us")).toBeNull();
    expect(mass(0.001, "us")).toBeNull();
  });
});

describe("metric volume", () => {
  it.each([
    [236.5882365, "240 ml"],
    [14.78676478125, "15 ml"],
    [29.5735295625, "30 ml"],
    [473.176473, "470 ml"],
    [946.352946, "950 ml"],
    [1000, "1 l"],
    [3785.411784, "3.8 l"],
  ])("%d ml → %s", (millilitres, expected) => {
    expect(volume(millilitres, "metric")).toBe(expected);
  });

  it("produces the conventional cup table without a lookup table", () => {
    // Every one of these is the number printed in real recipes, and not one of
    // them is enumerated anywhere in the engine. They fall out of a single grid
    // that widens with magnitude.
    expect(volume(236.5882365 / 4, "metric")).toBe("60 ml");
    expect(volume(236.5882365 / 3, "metric")).toBe("80 ml");
    expect(volume(236.5882365 / 2, "metric")).toBe("120 ml");
    expect(volume((236.5882365 * 2) / 3, "metric")).toBe("160 ml");
    expect(volume((236.5882365 * 3) / 4, "metric")).toBe("180 ml");
    expect(volume(236.5882365, "metric")).toBe("240 ml");
  });

  it("never emits a value no jug is graduated for", () => {
    // The defect this rule exists to fix: 236.5882365 ml is arithmetically
    // right and unusable. Nothing in the ordinary cooking range may come back
    // off the grid.
    for (let millilitres = 1; millilitres <= 2000; millilitres += 1.7) {
      const rendered = volume(millilitres, "metric") ?? "";
      const value = Number(/^([\d.]+)/.exec(rendered)?.[1] ?? "0");
      const asMillilitres = rendered.endsWith(" l") ? value * 1000 : value;

      const grid =
        asMillilitres < 10 ? 0.5 : asMillilitres < 50 ? 1 : asMillilitres < 100 ? 5 : asMillilitres < 1000 ? 10 : 50;

      expect(Math.abs(asMillilitres / grid - Math.round(asMillilitres / grid))).toBeLessThan(1e-9);
    }
  });

  it("never moves a value by more than about five percent", () => {
    // The rule the grid is derived from, asserted rather than described.
    for (let millilitres = 1; millilitres <= 5000; millilitres += 3.1) {
      const rendered = volume(millilitres, "metric") ?? "";
      const value = Number(/^([\d.]+)/.exec(rendered)?.[1] ?? "0");
      const asMillilitres = rendered.endsWith(" l") ? value * 1000 : value;

      expect(Math.abs(asMillilitres - millilitres) / millilitres).toBeLessThanOrEqual(0.051);
    }
  });

  it("keeps half-millilitre resolution for the smallest spoons", () => {
    expect(volume(4.92892159375, "metric")).toBe("5 ml");
    expect(volume(2.464460796875, "metric")).toBe("2.5 ml");
    expect(volume(1.23223039688, "metric")).toBe("1 ml");
  });

  it("chooses litres from the gridded value, not the raw one", () => {
    // 995 ml grids to 1000, and "1000 ml" would be a worse way to say "1 l".
    expect(volume(994, "metric")).toBe("990 ml");
    expect(volume(995, "metric")).toBe("1 l");
    expect(volume(1000, "metric")).toBe("1 l");
  });
});

describe("US volume", () => {
  it.each([
    [240, "1 cup"],
    [120, "1/2 cup"],
    [60, "1/4 cup"],
    [500, "2 1/8 cup"],
    [2000, "8 1/2 cup"],
  ])("%d ml → %s", (millilitres, expected) => {
    expect(volume(millilitres, "us")).toBe(expected);
  });

  it("steps down when nothing on the cup ladder is close enough", () => {
    // 100 ml is 0.423 cups. The nearest ladder fractions are 1/3 and 1/2, both
    // further away than the tolerance, so it becomes tablespoons instead of
    // being forced onto a fraction it does not fit.
    expect(volume(100, "us")).toBe("6 3/4 tbsp");
  });

  it("uses tablespoons below the quarter-cup floor", () => {
    // 30 ml is an eighth of a cup, but an eighth is below the cup floor, so it
    // reads as the 2 tbsp it also is. Both are right; the engine is consistent.
    expect(volume(30, "us")).toBe("2 tbsp");
    expect(volume(14.78676478125, "us")).toBe("1 tbsp");
  });

  it("uses teaspoons rather than a fraction of a tablespoon", () => {
    // 5 ml is 1/3 tbsp, which snaps perfectly and reads terribly.
    expect(volume(4.92892159375, "us")).toBe("1 tsp");
    expect(volume(9.8578, "us")).toBe("2 tsp");
  });

  it("only uses ASCII fractions", () => {
    for (const millilitres of [30, 60, 79, 120, 158, 177, 240, 500]) {
      expect(volume(millilitres, "us")).not.toMatch(/[½¾⅓⅔¼⅛]/);
    }
  });

  it("snaps to the ladder and to nothing else", () => {
    const LADDER = ["1/8", "1/4", "1/3", "1/2", "2/3", "3/4"];

    for (let millilitres = 60; millilitres <= 1200; millilitres += 7) {
      const rendered = volume(millilitres, "us") ?? "";
      const fraction = /(\d+\/\d+)/.exec(rendered)?.[1];

      if (fraction !== undefined) expect(LADDER).toContain(fraction);
    }
  });

  it("never renders a zero quantity", () => {
    for (let millilitres = 0.6; millilitres <= 40; millilitres += 0.31) {
      const rendered = volume(millilitres, "us");
      if (rendered !== null) expect(rendered).not.toMatch(/^0\b/);
    }
  });

  it("declines below an eighth of a teaspoon rather than inventing a floor", () => {
    // About half a drop. There is no smaller unit to step down to.
    expect(volume(0.2, "us")).toBeNull();
  });

  it("never selects fl oz, though it converts from it", () => {
    for (let millilitres = 1; millilitres <= 2000; millilitres += 13) {
      expect(volume(millilitres, "us")).not.toContain("fl oz");
    }

    // Still a supported input: 8 fl oz is a cup.
    expect(volume(8 * 29.5735295625, "metric")).toBe("240 ml");
  });
});

describe("formatting in a caller-chosen unit", () => {
  it("expresses a value in the unit it was asked for", () => {
    expect(formatQuantityInUnit(1000, "g")).toBe("1000");
    expect(formatQuantityInUnit(1000, "kg")).toBe("1");
    expect(formatQuantityInUnit(1000, "oz")).toBe("35.3");
    expect(formatQuantityInUnit(1000, "lb")).toBe("2.2");
  });

  it("uses fractions for US volumes and decimals for everything else", () => {
    expect(formatQuantityInUnit(120, "cup")).toBe("1/2");
    expect(formatQuantityInUnit(120, "ml")).toBe("120");
  });

  it("declines when the amount rounds away in the requested unit", () => {
    expect(formatQuantityInUnit(0.5, "kg")).toBeNull();
    expect(formatQuantityInUnit(0.01, "cup")).toBeNull();
  });
});

describe("guards", () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("refuses %p", (value) => {
    expect(formatMass(value, "metric")).toBeNull();
    expect(formatVolume(value, "us")).toBeNull();
  });
});
