import {
  GRAMS_PER_KILOGRAM,
  GRAMS_PER_MILLIGRAM,
  GRAMS_PER_OUNCE,
  GRAMS_PER_POUND,
  MILLILITRES_PER_CUP,
  MILLILITRES_PER_FLUID_OUNCE,
  MILLILITRES_PER_GALLON,
  MILLILITRES_PER_LITRE,
  MILLILITRES_PER_PINT,
  MILLILITRES_PER_QUART,
  MILLILITRES_PER_TABLESPOON,
  MILLILITRES_PER_TEASPOON,
} from "./constants.js";

/**
 * The engine's internal unit taxonomy.
 *
 * **This is deliberately not in the canonical Recipe schema.** The canonical
 * model records what a creator wrote — `unit: "cups"`, verbatim, whatever they
 * chose to call it. This taxonomy is the engine's private interpretation of
 * that text, and it exists only for the duration of a projection. Putting these
 * enums into `src/recipe/schema.ts` would turn a reading of the source into a
 * claim about the source, and would make the canonical model unable to hold a
 * unit the engine has not been taught.
 */

/**
 * What a measurement measures. Only `mass` and `volume` are ever arithmetic;
 * the rest exist so that "we recognised this and will not convert it" is a
 * distinct answer from "we did not recognise this".
 */
export type MeasurementKind = "mass" | "volume" | "count" | "descriptive" | "unknown";

/**
 * `neutral` is for measurements that belong to no system and need none — a
 * count of cloves is not metric or US. It is distinct from `unknown`, which
 * means the engine could not tell.
 */
export type UnitSystem = "metric" | "us" | "neutral" | "unknown";

/** Every unit the engine can convert. Nothing outside this set is arithmetic. */
export type ConvertibleUnit =
  | "mg"
  | "g"
  | "kg"
  | "oz"
  | "lb"
  | "ml"
  | "l"
  | "tsp"
  | "tbsp"
  | "fl_oz"
  | "cup"
  | "pint"
  | "quart"
  | "gallon";

export interface UnitDefinition {
  readonly id: ConvertibleUnit;
  readonly kind: "mass" | "volume";
  readonly system: "metric" | "us";
  /** Multiplier into the family's base unit: grams for mass, millilitres for volume. */
  readonly perBase: number;
  /** How the unit is written on output. The only place `fl_oz` becomes "fl oz". */
  readonly display: string;
}

/**
 * V1 disambiguation assumptions, applied wherever a unit name is genuinely
 * ambiguous in the wild. Each is a choice, not a fact, so each is written down:
 *
 * - **A bare `oz` is mass.** Fluid ounces must say so (`fl oz`, `fluid ounce`).
 *   Recipes overwhelmingly use bare `oz` for weight, and the alternative —
 *   guessing from the ingredient — is exactly the kind of inference this engine
 *   refuses.
 * - **`cup` is the US customary cup** (236.5882365 ml), not the metric cup
 *   (250 ml), the legal US nutrition-labelling cup (240 ml), or the imperial
 *   cup (284 ml).
 * - **`tsp` and `tbsp` are US customary.** The Australian tablespoon is 20 ml,
 *   four teaspoons rather than three; it is not supported.
 * - **`pint`, `quart`, and `gallon` are US liquid measures**, not imperial. An
 *   imperial pint is 568 ml against the US 473 ml, so this is a 20% choice and
 *   not a rounding one.
 *
 * A creator writing an imperial pint gets a US pint. The engine cannot tell
 * them apart from the text alone, and inventing a locale signal to guess with
 * would be worse than the documented assumption.
 */
export const UNIT_DEFINITIONS: { readonly [K in ConvertibleUnit]: UnitDefinition } = {
  mg: { id: "mg", kind: "mass", system: "metric", perBase: GRAMS_PER_MILLIGRAM, display: "mg" },
  g: { id: "g", kind: "mass", system: "metric", perBase: 1, display: "g" },
  kg: { id: "kg", kind: "mass", system: "metric", perBase: GRAMS_PER_KILOGRAM, display: "kg" },
  oz: { id: "oz", kind: "mass", system: "us", perBase: GRAMS_PER_OUNCE, display: "oz" },
  lb: { id: "lb", kind: "mass", system: "us", perBase: GRAMS_PER_POUND, display: "lb" },

  ml: { id: "ml", kind: "volume", system: "metric", perBase: 1, display: "ml" },
  l: { id: "l", kind: "volume", system: "metric", perBase: MILLILITRES_PER_LITRE, display: "l" },

  tsp: { id: "tsp", kind: "volume", system: "us", perBase: MILLILITRES_PER_TEASPOON, display: "tsp" },
  tbsp: {
    id: "tbsp",
    kind: "volume",
    system: "us",
    perBase: MILLILITRES_PER_TABLESPOON,
    display: "tbsp",
  },
  fl_oz: {
    id: "fl_oz",
    kind: "volume",
    system: "us",
    perBase: MILLILITRES_PER_FLUID_OUNCE,
    display: "fl oz",
  },
  cup: { id: "cup", kind: "volume", system: "us", perBase: MILLILITRES_PER_CUP, display: "cup" },
  pint: { id: "pint", kind: "volume", system: "us", perBase: MILLILITRES_PER_PINT, display: "pint" },
  quart: {
    id: "quart",
    kind: "volume",
    system: "us",
    perBase: MILLILITRES_PER_QUART,
    display: "quart",
  },
  gallon: {
    id: "gallon",
    kind: "volume",
    system: "us",
    perBase: MILLILITRES_PER_GALLON,
    display: "gallon",
  },
};

export const CONVERTIBLE_UNITS: readonly ConvertibleUnit[] = Object.keys(
  UNIT_DEFINITIONS,
) as ConvertibleUnit[];

/** Converts a scalar in `unit` into its family's base unit. */
export function toBase(value: number, unit: ConvertibleUnit): number {
  return value * UNIT_DEFINITIONS[unit].perBase;
}

/** Converts a scalar from a family's base unit into `unit`. */
export function fromBase(base: number, unit: ConvertibleUnit): number {
  return base / UNIT_DEFINITIONS[unit].perBase;
}
