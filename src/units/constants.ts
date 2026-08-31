/**
 * Every conversion constant in the engine, in one place.
 *
 * All are **exact** by definition rather than measured: the international
 * avoirdupois pound and the US customary fluid measures are defined in terms of
 * the metre and kilogram, so these are the defining values, not approximations
 * of them. Writing them out in full and deriving everything else from them
 * means the engine has exactly one place where a wrong number could enter, and
 * `constants.test.ts` checks the derived identities (1 lb = 16 oz, 1 cup =
 * 8 fl oz, 1 tbsp = 3 tsp, …) hold to the bit.
 *
 * Two base units, and only two:
 *
 * - mass converts through **grams**
 * - volume converts through **millilitres**
 *
 * There is deliberately no bridge between them. See `SAFE FAMILY RULE` in
 * `project.ts`: no density table exists in this engine, so no mass↔volume
 * conversion is representable, not merely disallowed.
 */

/** Exact: the international avoirdupois pound. */
export const GRAMS_PER_POUND = 453.59237;

/** Exact: 1 lb / 16. */
export const GRAMS_PER_OUNCE = GRAMS_PER_POUND / 16;

export const GRAMS_PER_KILOGRAM = 1000;
export const GRAMS_PER_MILLIGRAM = 0.001;

export const MILLILITRES_PER_LITRE = 1000;

/** Exact: the US customary gallon is defined as 231 cubic inches. */
export const MILLILITRES_PER_GALLON = 3785.411784;

export const MILLILITRES_PER_QUART = MILLILITRES_PER_GALLON / 4;
export const MILLILITRES_PER_PINT = MILLILITRES_PER_QUART / 2;
export const MILLILITRES_PER_CUP = MILLILITRES_PER_PINT / 2;
export const MILLILITRES_PER_FLUID_OUNCE = MILLILITRES_PER_CUP / 8;
export const MILLILITRES_PER_TABLESPOON = MILLILITRES_PER_FLUID_OUNCE / 2;
export const MILLILITRES_PER_TEASPOON = MILLILITRES_PER_TABLESPOON / 3;

/**
 * The relationships the values above must satisfy. Asserted rather than
 * assumed, because a typo in one constant would otherwise show up as a subtly
 * wrong recipe rather than a failing test.
 */
export const EXPECTED_IDENTITIES: ReadonlyArray<readonly [label: string, left: number, right: number]> = [
  ["1 lb = 16 oz", GRAMS_PER_POUND, GRAMS_PER_OUNCE * 16],
  ["1 oz = 28.349523125 g", GRAMS_PER_OUNCE, 28.349523125],
  ["1 kg = 1000 g", GRAMS_PER_KILOGRAM, 1000],
  ["1 l = 1000 ml", MILLILITRES_PER_LITRE, 1000],
  ["1 US fl oz = 29.5735295625 ml", MILLILITRES_PER_FLUID_OUNCE, 29.5735295625],
  ["1 US cup = 236.5882365 ml", MILLILITRES_PER_CUP, 236.5882365],
  ["1 tbsp = 14.78676478125 ml", MILLILITRES_PER_TABLESPOON, 14.78676478125],
  ["1 tsp = 4.92892159375 ml", MILLILITRES_PER_TEASPOON, 4.92892159375],
  ["1 cup = 8 fl oz", MILLILITRES_PER_CUP, MILLILITRES_PER_FLUID_OUNCE * 8],
  ["1 tbsp = 3 tsp", MILLILITRES_PER_TABLESPOON, MILLILITRES_PER_TEASPOON * 3],
  ["1 pint = 2 cups", MILLILITRES_PER_PINT, MILLILITRES_PER_CUP * 2],
  ["1 quart = 2 pints", MILLILITRES_PER_QUART, MILLILITRES_PER_PINT * 2],
  ["1 gallon = 4 quarts", MILLILITRES_PER_GALLON, MILLILITRES_PER_QUART * 4],
];
