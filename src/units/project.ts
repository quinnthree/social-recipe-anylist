import { classifyUnit } from "./aliases.js";
import {
  displayUnit,
  formatMass,
  formatQuantityInUnit,
  formatVolume,
  type FormattedMeasurement,
} from "./format.js";
import { parseQuantity, type ParsedQuantity } from "./quantity.js";
import {
  toBase,
  UNIT_DEFINITIONS,
  type ConvertibleUnit,
  type MeasurementKind,
  type UnitSystem,
} from "./taxonomy.js";

/**
 * The projection engine: canonical ingredient in, ephemeral Original / US /
 * Metric reading out.
 *
 * ## SAFE FAMILY RULE — absolute
 *
 * The engine **never** performs arithmetic between measurement families. Not
 * g↔cup, not g↔tbsp, not oz(mass)↔fl oz, not kg↔litre, not count↔anything, not
 * descriptive↔anything. This is not a policy that a future density table would
 * relax; it is structural. There is no density anywhere in this engine, so a
 * mass↔volume conversion is not merely forbidden, it is unrepresentable — the
 * two families have different base units and nothing bridges them.
 *
 * The one place cross-family information appears at all is an alternate the
 * **creator wrote themselves**, and §6 controls whether that is allowed to
 * become the primary reading. It never becomes a calculation.
 *
 * ## Nothing here is canonical data
 *
 * A `Projection` is computed on demand and thrown away. It is not persisted,
 * not returned by any API, and above all a **calculated value is never written
 * into `alternateMeasurements`** — that field means "the creator wrote this",
 * and putting a computed number in it would destroy the only guarantee it
 * makes.
 */

/** What the caller asked for. `original` is the canonical reading, unconverted. */
export type TargetSystem = "original" | "us" | "metric";

/** Where the projected measurement came from. */
export type ProjectionSource = "unchangedOriginal" | "authorAlternate" | "calculated";

/**
 * Why the engine answered as it did. Present so a test can assert the *reason*
 * rather than only the number — "unchanged because the unit was unknown" and
 * "unchanged because it was already US" are the same output and completely
 * different behaviour.
 */
export type ProjectionReason =
  | "original_requested"
  | "already_in_target_system"
  | "author_alternate_selected"
  | "calculated_conversion"
  | "unit_not_recognised"
  | "kind_not_convertible"
  | "quantity_not_parseable"
  | "no_representable_result";

/** An author-provided alternate, as the engine reads it. */
export interface AlternateView {
  readonly quantity: string;
  readonly unit: string | null;
  readonly descriptor: string | null;
  readonly kind: MeasurementKind;
  readonly system: UnitSystem;
}

export interface Projection {
  readonly source: ProjectionSource;
  readonly reason: ProjectionReason;
  /** Display quantity. Verbatim from the source for everything but `calculated`. */
  readonly quantity: string | null;
  /** Display unit. Verbatim from the source for everything but `calculated`. */
  readonly unit: string | null;
  /** Set only when an author alternate was selected and carried one. */
  readonly descriptor: string | null;
  readonly kind: MeasurementKind;
  /** The system of the measurement actually produced. */
  readonly system: UnitSystem;
  readonly target: TargetSystem;
  /** The canonical unit id behind `unit`, when the engine recognised one. */
  readonly canonicalUnit: ConvertibleUnit | null;
  /** Every author alternate not chosen as primary, in source order. */
  readonly secondaryAlternates: readonly AlternateView[];
}

/**
 * The shape the engine reads. Structurally a canonical `Ingredient`, restated
 * here so the engine depends on no schema module at runtime and stays dormant
 * (see `tests/architecture/unit-engine-dormancy.test.ts`). The compile-time
 * bridge in `canonical-compatibility.ts` proves the two cannot drift.
 */
export interface MeasuredInput {
  readonly quantity: string | null;
  readonly unit: string | null;
  readonly alternateMeasurements:
    | readonly {
        readonly quantity: string;
        readonly unit: string | null;
        readonly descriptor: string | null;
      }[]
    | null;
}

/**
 * Projects one ingredient into the requested system.
 *
 * Order of decisions, which is the whole contract:
 *
 * 1. `original` → the canonical reading, untouched.
 * 2. Not a mass or a volume → untouched. A count of cloves has no US form.
 * 3. **Already in the target system → untouched.** This precedes the alternate
 *    search on purpose: `14 oz` asked for in US is already the answer, and
 *    rewriting it into another US unit merely because the engine could would be
 *    churn the user never asked for.
 * 4. A creator-provided alternate in the target system, of the same family →
 *    used **verbatim**. No recalculation, no rounding, no renormalising of its
 *    quantity string. Note this needs no parseable quantity: `2 to 2.5` is
 *    unusable arithmetically and perfectly usable verbatim.
 * 5. Otherwise a safe calculated conversion, if the primary quantity parses.
 * 6. Otherwise untouched, with the reason recorded.
 */
export function project(ingredient: MeasuredInput, target: TargetSystem): Projection {
  const primary = classifyUnit(ingredient.unit);
  const alternates = readAlternates(ingredient);

  const unchanged = (reason: ProjectionReason): Projection => ({
    source: "unchangedOriginal",
    reason,
    quantity: ingredient.quantity,
    unit: ingredient.unit,
    descriptor: null,
    kind: primary.kind,
    system: primary.system,
    target,
    canonicalUnit: primary.unit,
    secondaryAlternates: alternates,
  });

  if (target === "original") return unchanged("original_requested");

  if (primary.unit === null) {
    // Count, descriptive, or a word the table does not contain. Each is a
    // different diagnosis and none of them converts.
    return unchanged(primary.kind === "unknown" ? "unit_not_recognised" : "kind_not_convertible");
  }

  if (primary.system === target) return unchanged("already_in_target_system");

  const chosen = selectAlternate(alternates, target, primary.kind);
  if (chosen !== null) {
    return {
      source: "authorAlternate",
      reason: "author_alternate_selected",
      // Verbatim. The creator's own words are better than anything computed.
      quantity: chosen.alternate.quantity,
      unit: chosen.alternate.unit,
      descriptor: chosen.alternate.descriptor,
      kind: chosen.alternate.kind,
      system: chosen.alternate.system,
      target,
      canonicalUnit: chosen.canonicalUnit,
      secondaryAlternates: alternates.filter((_, index) => index !== chosen.index),
    };
  }

  const parsed = parseQuantity(ingredient.quantity);
  if (parsed === null) return unchanged("quantity_not_parseable");

  const calculated = calculate(parsed, primary.unit, target);
  if (calculated === null) return unchanged("no_representable_result");

  return {
    source: "calculated",
    reason: "calculated_conversion",
    quantity: calculated.quantity,
    unit: displayUnit(calculated.unit),
    descriptor: null,
    kind: primary.kind,
    system: target,
    target,
    canonicalUnit: calculated.unit,
    secondaryAlternates: alternates,
  };
}

/**
 * Converts within one family and formats the result.
 *
 * The conversion goes through the family's base unit — grams for mass,
 * millilitres for volume — and rounds only at the end, so no intermediate step
 * accumulates rounding error. A range converts both endpoints and renders them
 * in the **larger endpoint's** unit, so that `1-2 lb` cannot come back as
 * `16 oz-2 lb`.
 */
function calculate(
  parsed: ParsedQuantity,
  unit: ConvertibleUnit,
  target: "us" | "metric",
): FormattedMeasurement | null {
  const family = UNIT_DEFINITIONS[unit].kind;

  if (parsed.kind === "exact") return formatIn(toBase(parsed.value, unit), family, target);

  // Both ends share one unit, chosen by the **lower** end.
  //
  // Letting the upper end choose looks natural and reads badly: `400-500 g` in
  // US has an upper end just past the 16 oz mark, so the pair would render as
  // `0.88-1.1 lb` — a range whose smaller half is a fraction of the unit it is
  // quoted in. The lower end picks the largest unit it can still fill, and the
  // upper end is by definition larger, so neither can come out below one.
  const lower = formatIn(toBase(parsed.min, unit), family, target);
  if (lower === null) return null;

  const upper = formatQuantityInUnit(toBase(parsed.max, unit), lower.unit);
  if (upper === null) return null;

  return { quantity: `${lower.quantity}-${upper}`, unit: lower.unit };
}

function formatIn(
  base: number,
  family: "mass" | "volume",
  target: "us" | "metric",
): FormattedMeasurement | null {
  return family === "mass" ? formatMass(base, target) : formatVolume(base, target);
}

/** Reads the author alternates, classifying each without altering any of them. */
function readAlternates(ingredient: MeasuredInput): readonly AlternateView[] {
  return (ingredient.alternateMeasurements ?? []).map((alternate) => {
    const classification = classifyUnit(alternate.unit);
    return {
      quantity: alternate.quantity,
      unit: alternate.unit,
      descriptor: alternate.descriptor,
      kind: classification.kind,
      system: classification.system,
    };
  });
}

/**
 * Picks the creator-provided alternate that may replace the primary.
 *
 * All three conditions are required, and each rules out a real case:
 *
 * - **the unit is recognised** — `2 to 2.5 medium sweet potatoes` has no unit
 *   and must never become a measurement;
 * - **it is in the requested system** — a metric alternate is no help to a US
 *   projection;
 * - **its family matches the primary's** — `1 cup sliced` beside `100 g` is a
 *   volume beside a mass. Selecting it would be exactly the cross-family swap
 *   the safe-family rule forbids, done by hand instead of by arithmetic.
 *
 * When several qualify, source order wins and the first is taken. The creator
 * wrote them in an order; that order is information.
 */
function selectAlternate(
  alternates: readonly AlternateView[],
  target: "us" | "metric",
  primaryKind: MeasurementKind,
): { alternate: AlternateView; index: number; canonicalUnit: ConvertibleUnit } | null {
  for (const [index, alternate] of alternates.entries()) {
    const classification = classifyUnit(alternate.unit);
    if (classification.unit === null) continue;
    if (classification.system !== target) continue;
    if (classification.kind !== primaryKind) continue;

    return { alternate, index, canonicalUnit: classification.unit };
  }

  return null;
}
