import { describe, expect, it } from "vitest";

import { classifyUnit } from "./aliases.js";
import { project, type MeasuredInput, type TargetSystem } from "./project.js";
import { CONVERTIBLE_UNITS, UNIT_DEFINITIONS, type ConvertibleUnit } from "./taxonomy.js";

/**
 * The mass/volume family invariant, proved by exhaustion rather than by reading
 * the code.
 *
 * The safe family rule is the single most important property in this engine: a
 * mass silently rendered as a volume is not a rounding error, it is a wrong
 * recipe. Inspection is not enough to establish it, because the rule has to hold
 * across a product of choices — fourteen input units, two targets, every
 * quantity shape, and every combination of author alternates including
 * deliberately cross-family ones.
 *
 * So the whole product is enumerated here and the invariant asserted on every
 * result. These tests are also what a mistaken report is checked against: the
 * B4-C report claimed `0.5 g` targeting US "declines because it is below an
 * eighth of a teaspoon". It declines because 0.0176 **ounces** rounds to zero —
 * a mass path throughout — and no teaspoon was ever considered. The wording was
 * wrong; the code was not. `us-mass-too-small-never-considers-volume` pins that
 * distinction so the claim cannot be made loosely again.
 */

const VOLUME_UNITS: readonly ConvertibleUnit[] = CONVERTIBLE_UNITS.filter(
  (unit) => UNIT_DEFINITIONS[unit].kind === "volume",
);

const MASS_UNITS: readonly ConvertibleUnit[] = CONVERTIBLE_UNITS.filter(
  (unit) => UNIT_DEFINITIONS[unit].kind === "mass",
);

/** Display labels a result must never carry when the input was the other family. */
const VOLUME_LABELS = VOLUME_UNITS.map((unit) => UNIT_DEFINITIONS[unit].display);
const MASS_LABELS = MASS_UNITS.map((unit) => UNIT_DEFINITIONS[unit].display);

/** Quantity shapes spanning every branch of the parser, plus unparseable ones. */
const QUANTITIES: readonly string[] = [
  "0.001",
  "0.5",
  "1",
  "1/8",
  "1/2",
  "1 1/2",
  "1½",
  "¾",
  "2",
  "3.5",
  "8",
  "16",
  "100",
  "240",
  "400",
  "1000",
  "5000",
  "2-3",
  "2 to 2.5",
  "about two",
];

const TARGETS: readonly TargetSystem[] = ["original", "us", "metric"];

/** Alternates chosen to be maximally tempting: same system, wrong family. */
const CROSS_FAMILY_ALTERNATES = [
  [{ quantity: "1", unit: "cup", descriptor: "sliced" }],
  [{ quantity: "8", unit: "fl oz", descriptor: null }],
  [{ quantity: "1", unit: "tbsp", descriptor: null }],
  [{ quantity: "250", unit: "g", descriptor: null }],
  [{ quantity: "8", unit: "oz", descriptor: null }],
  [{ quantity: "1", unit: "lb", descriptor: null }],
  [{ quantity: "1", unit: "l", descriptor: null }],
];

interface Case {
  input: MeasuredInput;
  target: TargetSystem;
  family: "mass" | "volume";
}

/** Every input unit × quantity × target × alternate set. */
function everyCase(): Case[] {
  const cases: Case[] = [];

  for (const unit of CONVERTIBLE_UNITS) {
    const family = UNIT_DEFINITIONS[unit].kind;

    for (const alias of [unit, UNIT_DEFINITIONS[unit].display]) {
      for (const quantity of QUANTITIES) {
        for (const target of TARGETS) {
          cases.push({ input: { quantity, unit: alias, alternateMeasurements: null }, target, family });

          for (const alternateMeasurements of CROSS_FAMILY_ALTERNATES) {
            cases.push({ input: { quantity, unit: alias, alternateMeasurements }, target, family });
          }
        }
      }
    }
  }

  return cases;
}

const CASES = everyCase();

describe("no execution path crosses the mass/volume boundary", () => {
  it("enumerates a product large enough to be meaningful", () => {
    // 14 units × 2 spellings × 20 quantities × 3 targets × 8 alternate sets.
    expect(CASES.length).toBeGreaterThanOrEqual(10_000);
  });

  it("never returns a volume unit for a mass input", () => {
    const offenders = CASES.filter(({ input, target, family }) => {
      if (family !== "mass") return false;

      const projection = project(input, target);
      if (projection.canonicalUnit === null) return false;

      return UNIT_DEFINITIONS[projection.canonicalUnit].kind !== "mass";
    });

    expect(offenders).toEqual([]);
  });

  it("never returns a mass unit for a volume input", () => {
    const offenders = CASES.filter(({ input, target, family }) => {
      if (family !== "volume") return false;

      const projection = project(input, target);
      if (projection.canonicalUnit === null) return false;

      return UNIT_DEFINITIONS[projection.canonicalUnit].kind !== "volume";
    });

    expect(offenders).toEqual([]);
  });

  it("never even prints the other family's label", () => {
    // Belt and braces: `canonicalUnit` could in principle be null while the
    // displayed unit came from somewhere else. It cannot, and this proves it.
    for (const { input, target, family } of CASES) {
      const projection = project(input, target);
      if (projection.source !== "calculated") continue;

      const forbidden = family === "mass" ? VOLUME_LABELS : MASS_LABELS;
      expect(forbidden).not.toContain(projection.unit);
    }
  });

  it("reports a kind that matches the input's family on every calculation", () => {
    for (const { input, target, family } of CASES) {
      const projection = project(input, target);
      if (projection.source === "calculated") expect(projection.kind).toBe(family);
    }
  });

  it("never selects a cross-family author alternate, however tempting", () => {
    for (const { input, target, family } of CASES) {
      const projection = project(input, target);
      if (projection.source !== "authorAlternate") continue;

      expect(classifyUnit(projection.unit).kind).toBe(family);
    }
  });
});

describe("the two formatters are the only exits, and neither can cross", () => {
  it("mass inputs only ever produce g, kg, oz, or lb", () => {
    const produced = new Set<string>();

    for (const { input, target, family } of CASES) {
      if (family !== "mass") continue;

      const projection = project(input, target);
      if (projection.source === "calculated" && projection.unit !== null) {
        produced.add(projection.unit);
      }
    }

    expect([...produced].sort()).toEqual(["g", "kg", "lb", "oz"]);
  });

  it("volume inputs only ever produce ml, l, tsp, tbsp, or cup", () => {
    const produced = new Set<string>();

    for (const { input, target, family } of CASES) {
      if (family !== "volume") continue;

      const projection = project(input, target);
      if (projection.source === "calculated" && projection.unit !== null) {
        produced.add(projection.unit);
      }
    }

    // `fl oz`, `pint`, `quart` and `gallon` are absent because the US volume
    // ladder never selects them, not because a family was crossed.
    expect([...produced].sort()).toEqual(["cup", "l", "ml", "tbsp", "tsp"]);
  });
});

describe("a mass too small to express declines as a mass", () => {
  it("us-mass-too-small-never-considers-volume", () => {
    // The case the B4-C report described incorrectly. 0.5 g is 0.0176 oz, which
    // rounds to 0.0 oz, so the engine declines and returns the original. A
    // teaspoon is a volume and was never a candidate: the family was fixed by
    // the input unit before any formatter was reached.
    const projection = project({ quantity: "0.5", unit: "g", alternateMeasurements: null }, "us");

    expect(projection.source).toBe("unchangedOriginal");
    expect(projection.reason).toBe("no_representable_result");
    expect(projection.quantity).toBe("0.5");
    expect(projection.unit).toBe("g");
    expect(projection.kind).toBe("mass");
    expect(VOLUME_LABELS).not.toContain(projection.unit);
  });

  it("declines rather than borrowing a volume unit at any tiny mass", () => {
    for (const quantity of ["0.0001", "0.001", "0.01", "0.1", "0.5"]) {
      const projection = project({ quantity, unit: "g", alternateMeasurements: null }, "us");

      expect(projection.kind).toBe("mass");
      expect(VOLUME_LABELS).not.toContain(projection.unit);
    }
  });

  it("does not borrow a volume unit even when the ingredient offers one", () => {
    const projection = project(
      {
        quantity: "0.5",
        unit: "g",
        alternateMeasurements: [{ quantity: "1/8", unit: "tsp", descriptor: null }],
      },
      "us",
    );

    // The creator's own teaspoon is right there, in the target system, and is
    // still refused: it is a volume beside a mass.
    expect(projection.source).toBe("unchangedOriginal");
    expect(projection.unit).toBe("g");
  });

  it("declines rather than borrowing a mass unit at any tiny volume", () => {
    for (const quantity of ["0.0001", "0.001", "0.01"]) {
      const projection = project({ quantity, unit: "ml", alternateMeasurements: null }, "us");

      expect(projection.kind).toBe("volume");
      expect(MASS_LABELS).not.toContain(projection.unit);
    }
  });
});
