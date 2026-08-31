import type { ConvertibleUnit } from "./taxonomy.js";
import { fromBase, UNIT_DEFINITIONS } from "./taxonomy.js";

/**
 * Deterministic culinary rounding.
 *
 * The governing principle is **not** significant figures from the source. A
 * creator writing `400g` did not mean three significant figures, and rendering
 * that as `14.109553 oz` would be false precision dressed up as rigour. The
 * engine aims instead at the quantity a cook would actually measure, then
 * commits to that rule and pins it with vectors.
 *
 * Every rule below is a decision, and several have boundaries that can look
 * surprising. The surprising ones are named in the comments rather than smoothed
 * over with more machinery, because a rule you can predict beats a rule that is
 * usually prettier.
 *
 * Output is ASCII throughout: `1/2`, never `½`. The backend has no Unicode
 * fraction requirement, and a client that wants one can render it.
 */

/** How close a value must be to a ladder fraction before it is snapped to it. */
const SNAP_TOLERANCE = 0.05;

/**
 * The fractions a cook measures. `1/8` is the finest, which is why it doubles as
 * the last-resort grid: an eighth of a teaspoon is 0.6 ml, so nothing useful is
 * lost by rounding to it.
 */
const LADDER: ReadonlyArray<readonly [value: number, text: string]> = [
  [0, ""],
  [1 / 8, "1/8"],
  [1 / 4, "1/4"],
  [1 / 3, "1/3"],
  [1 / 2, "1/2"],
  [2 / 3, "2/3"],
  [3 / 4, "3/4"],
  [1, ""], // carries into the whole part
];

export interface FormattedMeasurement {
  readonly quantity: string;
  readonly unit: ConvertibleUnit;
}

/**
 * Units the engine will choose for a calculated US volume, largest first, with
 * the smallest amount each is allowed to express.
 *
 * `cup` may go fractional down to a quarter, because `1/4 cup` and `1/2 cup` are
 * the most familiar measures in the entire US vocabulary and refusing to use
 * them below 1 would be perverse. `tbsp` and `tsp` must reach a whole unit
 * first, which is what keeps 5 ml reading as `1 tsp` rather than `1/3 tbsp`.
 *
 * **`fl_oz` is deliberately absent from this ladder.** It is fully supported as
 * an *input* unit — parsed, classified, converted from — but every volume it
 * would win is more familiar as tablespoons or cups, and including it would mean
 * `120 ml` rendering as `4 fl oz` instead of `1/2 cup`. Recognising a unit and
 * choosing to emit it are separate decisions.
 */
const US_VOLUME_LADDER: ReadonlyArray<readonly [unit: ConvertibleUnit, floor: number]> = [
  ["cup", 1 / 4],
  ["tbsp", 1],
  ["tsp", 1],
];

/**
 * Formats a mass given in grams, choosing the unit.
 *
 * **Metric.** Kilograms at or above 1000 g, otherwise grams. Under 10 g one
 * decimal is kept, because 7.5 g is a real distinction; at or above 10 g the
 * value is whole, because 227.4 g is not.
 *
 * **US.** Pounds at or above 16 oz, otherwise ounces. Ounces carry one decimal
 * and pounds at most two — enough for `2.2 lb`, not enough for `2.20462 lb`.
 */
export function formatMass(grams: number, system: "metric" | "us"): FormattedMeasurement | null {
  if (!Number.isFinite(grams) || grams <= 0) return null;

  const unit = system === "metric" ? (grams >= 1000 ? "kg" : "g") : chooseUsMassUnit(grams);
  const quantity = formatQuantityInUnit(grams, unit);

  return quantity === null ? null : { quantity, unit };
}

function chooseUsMassUnit(grams: number): ConvertibleUnit {
  return fromBase(grams, "oz") >= 16 ? "lb" : "oz";
}

/**
 * Formats a volume given in millilitres, choosing the unit.
 *
 * **Metric.** Litres at or above 1000 ml, otherwise millilitres. Under 10 ml the
 * value snaps to the nearest half-millilitre, which is what turns a US teaspoon
 * — 4.92892 ml — into the `5 ml` every metric cook already calls a teaspoon,
 * rather than a spuriously exact `4.9`.
 *
 * **US.** See `chooseUsVolume`.
 */
export function formatVolume(
  millilitres: number,
  system: "metric" | "us",
): FormattedMeasurement | null {
  if (!Number.isFinite(millilitres) || millilitres <= 0) return null;

  if (system === "us") return chooseUsVolume(millilitres);

  const unit = millilitres >= 1000 ? "l" : "ml";
  const quantity = formatQuantityInUnit(millilitres, unit);

  return quantity === null ? null : { quantity, unit };
}

/**
 * Picks the largest US unit in which the amount both clears its floor and lands
 * close to a measurable fraction; failing that, the largest unit holding at
 * least one whole unit, snapped to the nearest eighth.
 *
 * The two-pass shape is what produces the familiar answers. `120 ml` is 0.507
 * cups, which snaps to `1/2 cup`. `100 ml` is 0.423 cups, which snaps to nothing
 * — the nearest ladder fractions are 0.077 and 0.089 away — so it steps down and
 * becomes `6 3/4 tbsp`, both accurate and measurable.
 *
 * Boundary worth knowing: `30 ml` reads as `2 tbsp`, not `1/8 cup`, because an
 * eighth of a cup is below the cup floor. Both are correct; the engine picks one
 * and always picks the same one.
 */
function chooseUsVolume(millilitres: number): FormattedMeasurement | null {
  for (const [unit, floor] of US_VOLUME_LADDER) {
    const value = fromBase(millilitres, unit);
    if (value < floor) continue;

    const snapped = snapWithinTolerance(value);
    if (snapped !== null) return { quantity: snapped, unit };
  }

  for (const [unit] of US_VOLUME_LADDER) {
    if (fromBase(millilitres, unit) < 1) continue;

    const snapped = snapToNearest(fromBase(millilitres, unit));
    if (snapped !== "0") return { quantity: snapped, unit };
  }

  // Smaller than an eighth of a teaspoon — about half a drop. There is no
  // smaller unit to step down to, so the engine declines rather than inventing a
  // floor or rounding somebody's measurement to zero.
  const snapped = snapToNearest(fromBase(millilitres, "tsp"));
  return snapped === "0" ? null : { quantity: snapped, unit: "tsp" };
}

/**
 * Formats a base-unit amount in a **caller-chosen** unit, applying that unit's
 * rounding rule. Used for the lower end of a range, which must be expressed in
 * the same unit the upper end chose.
 *
 * Returns null when the amount rounds away to nothing in that unit, which is the
 * engine declining rather than reporting zero of something.
 */
export function formatQuantityInUnit(base: number, unit: ConvertibleUnit): string | null {
  const definition = UNIT_DEFINITIONS[unit];
  const value = fromBase(base, unit);

  if (!Number.isFinite(value) || value <= 0) return null;

  // US volumes are measured in fractions of a cup or spoon, never in decimals.
  if (definition.system === "us" && definition.kind === "volume") {
    const snapped = snapToNearest(value);
    return snapped === "0" ? null : snapped;
  }

  const rounded = roundForUnit(unit, value);

  return rounded > 0 ? `${rounded}` : null;
}

/**
 * Each unit's rounding rule, stated per unit rather than inferred from
 * magnitude, so no rule can quietly leak onto a unit it was not written for.
 *
 * - **g** — whole grams at 10 g and above, one decimal below, because 7.5 g is a
 *   real distinction and 227.4 g is not.
 * - **ml** — whole millilitres at 10 ml and above; below that the nearest half
 *   millilitre, which is what turns a US teaspoon (4.92892 ml) into the `5 ml`
 *   every metric cook already calls a teaspoon.
 * - **oz** — one decimal always. `400 g` becomes `14.1 oz` and `250 g` becomes
 *   `8.8 oz`, which is exactly what creators write themselves.
 * - **kg, lb, l** — at most two decimals. Enough for `2.2 lb`, not enough for
 *   `2.20462 lb`.
 */
function roundForUnit(unit: ConvertibleUnit, value: number): number {
  switch (unit) {
    case "g":
      return value < 10 ? round(value, 1) : round(value, 0);
    case "ml":
      return value < 10 ? Math.round(value * 2) / 2 : round(value, 0);
    case "oz":
      return round(value, 1);
    case "kg":
    case "lb":
    case "l":
      return round(value, 2);
    default:
      // mg, and the large US volumes the ladder never selects.
      return round(value, 2);
  }
}

function round(value: number, places: number): number {
  return Number(value.toFixed(places));
}

/** Snaps to a ladder fraction only if one is close enough to be honest. */
function snapWithinTolerance(value: number): string | null {
  const whole = Math.floor(value);
  const fraction = value - whole;

  let best: (typeof LADDER)[number] | null = null;
  for (const candidate of LADDER) {
    const distance = Math.abs(fraction - candidate[0]);
    if (distance > SNAP_TOLERANCE) continue;
    if (best === null || distance < Math.abs(fraction - best[0])) best = candidate;
  }

  return best === null ? null : compose(whole, best);
}

/** Snaps to the nearest ladder fraction, unconditionally. The last-resort grid. */
function snapToNearest(value: number): string {
  const whole = Math.floor(value);
  const fraction = value - whole;

  let best = LADDER[0] as (typeof LADDER)[number];
  for (const candidate of LADDER) {
    if (Math.abs(fraction - candidate[0]) < Math.abs(fraction - best[0])) best = candidate;
  }

  return compose(whole, best);
}

/** `2` + `1/8` → "2 1/8"; `0` + `1/2` → "1/2"; `1` + carry → "2". */
function compose(whole: number, [value, text]: (typeof LADDER)[number]): string {
  const carried = value === 1 ? whole + 1 : whole;

  if (text.length === 0) return `${carried}`;
  return carried === 0 ? text : `${carried} ${text}`;
}

/** The display label for a unit — the only place `fl_oz` becomes "fl oz". */
export function displayUnit(unit: ConvertibleUnit): string {
  return UNIT_DEFINITIONS[unit].display;
}
