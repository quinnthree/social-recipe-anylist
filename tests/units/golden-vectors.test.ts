import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { classifyUnit } from "../../src/units/aliases.js";
import { project, type MeasuredInput, type TargetSystem } from "../../src/units/project.js";
import { parseQuantity } from "../../src/units/quantity.js";

/**
 * The shared conversion specification, executed against this implementation.
 *
 * The same file is the contract for the Swift engine in B4-D. It must be copied
 * **verbatim** into the iOS repository, its SHA-256 pinned there exactly as it
 * is pinned here, and every vector must produce identical results. Two engines
 * agreeing with a shared file cannot drift; two engines agreeing with their own
 * tests can drift for years without anyone noticing.
 */

const VECTOR_PATH = "tests/fixtures/unit-conversion-v1.json";

/**
 * Pinned so the file cannot change without the change being deliberate.
 *
 * When a vector legitimately needs to change, this constant changes with it in
 * the same commit — and B4-D's Swift pin has to change too, which is the point.
 * A silent edit fails here first.
 */
const VECTOR_SHA256 = "bbb4d0b77735cf29971780b2ca1e1ab0d34fdccfa131d49c1d86e0e897c06b3e";

interface ProjectionVector {
  id: string;
  group: string;
  description: string;
  input: MeasuredInput;
  target: TargetSystem;
  expected: {
    source: string;
    reason: string;
    quantity: string | null;
    unit: string | null;
    descriptor: string | null;
    kind: string;
    system: string;
    canonicalUnit: string | null;
    secondaryAlternateCount: number;
  };
}

interface Specification {
  version: string;
  assumptions: string[];
  constants: Record<string, number>;
  rounding: {
    culinaryMillilitreGrid: { bands: Array<{ below: number | null; grid: number }> };
  };
  vectors: ProjectionVector[];
  quantityGrammar: Array<{ input: string; expected: unknown }>;
  unitClassification: Array<{
    input: string;
    unit: string | null;
    kind: string;
    system: string;
  }>;
}

const raw = readFileSync(VECTOR_PATH, "utf8");
const spec = JSON.parse(raw) as Specification;

describe("the shared specification file", () => {
  it("matches its pinned SHA-256", () => {
    const digest = createHash("sha256").update(raw).digest("hex");

    // If this fails, the file changed. Either restore it, or update this
    // constant AND the pin in the iOS implementation in the same change.
    expect(digest).toBe(VECTOR_SHA256);
  });

  it("declares its version", () => {
    expect(spec.version).toBe("unit-conversion-v1");
  });

  it("records the V1 disambiguation assumptions", () => {
    // The assumptions are part of the contract, not commentary: a Swift engine
    // that treats a bare "oz" as a fluid ounce would pass every arithmetic
    // vector and still be wrong.
    expect(spec.assumptions.join(" ")).toContain("bare 'oz' is mass");
    expect(spec.assumptions.join(" ")).toContain("236.5882365");
    // The culinary-rounding assumption is part of the contract too: a Swift
    // engine emitting a mathematically perfect 237 ml would pass every
    // arithmetic check and still be wrong for a kitchen.
    expect(spec.assumptions.join(" ")).toContain("240 ml on every jug");
  });

  it("states the culinary millilitre grid B4-D has to reimplement", () => {
    expect(spec.rounding.culinaryMillilitreGrid.bands).toEqual([
      { below: 10, grid: 0.5 },
      { below: 50, grid: 1 },
      { below: 100, grid: 5 },
      { below: 1000, grid: 10 },
      { below: null, grid: 50 },
    ]);
  });

  it("carries every vector group", () => {
    expect(new Set(spec.vectors.map((vector) => vector.group))).toEqual(
      new Set([
        "author-alternate-precedence",
        "forbidden-cross-family",
        "calculated-mass",
        "calculated-volume",
        "ranges",
        "unchanged",
        "original",
      ]),
    );
  });

  it("has a unique id for every vector", () => {
    const ids = spec.vectors.map((vector) => vector.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is large enough to be worth pinning", () => {
    expect(spec.vectors.length).toBeGreaterThanOrEqual(58);
    expect(spec.quantityGrammar.length).toBeGreaterThanOrEqual(40);
    expect(spec.unitClassification.length).toBeGreaterThanOrEqual(90);
  });
});

describe("projection vectors", () => {
  it.each(spec.vectors.map((vector) => [`${vector.group}/${vector.id}`, vector] as const))(
    "%s",
    (_id, vector) => {
      const actual = project(vector.input, vector.target);

      expect({
        source: actual.source,
        reason: actual.reason,
        quantity: actual.quantity,
        unit: actual.unit,
        descriptor: actual.descriptor,
        kind: actual.kind,
        system: actual.system,
        canonicalUnit: actual.canonicalUnit,
        secondaryAlternateCount: actual.secondaryAlternates.length,
      }).toEqual(vector.expected);
    },
  );

  it("never reports a calculated value as the creator's", () => {
    for (const vector of spec.vectors) {
      if (vector.expected.source !== "calculated") continue;

      const stated = (vector.input.alternateMeasurements ?? []).map((a) => a.quantity);
      expect(stated).not.toContain(vector.expected.quantity);
    }
  });

  it("never reports an author alternate the input did not contain", () => {
    for (const vector of spec.vectors) {
      if (vector.expected.source !== "authorAlternate") continue;

      const stated = (vector.input.alternateMeasurements ?? []).map((a) => a.quantity);
      expect(stated).toContain(vector.expected.quantity);
    }
  });

  it("leaves the input untouched on every unchanged vector", () => {
    for (const vector of spec.vectors) {
      if (vector.expected.source !== "unchangedOriginal") continue;

      expect(vector.expected.quantity).toBe(vector.input.quantity);
      expect(vector.expected.unit).toBe(vector.input.unit);
    }
  });
});

describe("quantity grammar vectors", () => {
  it.each(spec.quantityGrammar.map((vector) => [JSON.stringify(vector.input), vector] as const))(
    "%s",
    (_label, vector) => {
      expect(parseQuantity(vector.input)).toEqual(vector.expected);
    },
  );

  it("includes rejections as well as acceptances", () => {
    const rejected = spec.quantityGrammar.filter((vector) => vector.expected === null);

    // A grammar spec listing only what parses would let a permissive
    // implementation pass while accepting "about two".
    expect(rejected.length).toBeGreaterThanOrEqual(15);
  });
});

describe("unit classification vectors", () => {
  it.each(spec.unitClassification.map((vector) => [vector.input, vector] as const))(
    "%s",
    (_alias, vector) => {
      const classification = classifyUnit(vector.input);

      expect({
        unit: classification.unit,
        kind: classification.kind,
        system: classification.system,
      }).toEqual({ unit: vector.unit, kind: vector.kind, system: vector.system });
    },
  );

  it("covers every convertible unit at least once", () => {
    const covered = new Set(
      spec.unitClassification.map((vector) => vector.unit).filter((unit) => unit !== null),
    );

    expect(covered).toEqual(
      new Set([
        "mg",
        "g",
        "kg",
        "oz",
        "lb",
        "ml",
        "l",
        "tsp",
        "tbsp",
        "fl_oz",
        "cup",
        "pint",
        "quart",
        "gallon",
      ]),
    );
  });
});
