import type { ConvertibleUnit, MeasurementKind, UnitSystem } from "./taxonomy.js";
import { UNIT_DEFINITIONS } from "./taxonomy.js";

/**
 * One explicit alias table, matched exactly.
 *
 * **No fuzzy matching, ever.** Not edit distance, not prefix matching, not
 * stemming. A unit the table does not list is `unknown`, and an unknown unit is
 * never converted. The failure mode of guessing here is silently rescaling
 * somebody's dinner by a factor of thirty, which is strictly worse than
 * declining to convert — so the engine declines.
 *
 * Adding an alias is a deliberate edit to this table and nothing else.
 */

/**
 * Normalises a raw unit string to the table's key form:
 *
 * 1. lower-cased, so `Tbsp` and `TBSP` match;
 * 2. periods removed, so `tsp.` and `fl. oz.` match — abbreviation dots carry
 *    no meaning here;
 * 3. internal whitespace collapsed and the ends trimmed, so `  fl   oz ` is
 *    `fl oz`.
 *
 * Applied to the alias keys at construction as well as to lookups, so the two
 * can never disagree about what a key looks like.
 */
export function normaliseUnitText(raw: string): string {
  return raw.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
}

/** The alias vocabulary, exactly as documented. */
const CONVERTIBLE_ALIASES: { readonly [K in ConvertibleUnit]: readonly string[] } = {
  mg: ["mg", "milligram", "milligrams", "milligramme", "milligrammes"],
  g: ["g", "gram", "grams", "gr", "gramme", "grammes"],
  kg: ["kg", "kilo", "kilos", "kilogram", "kilograms", "kilogramme", "kilogrammes"],
  oz: ["oz", "ounce", "ounces"],
  lb: ["lb", "lbs", "pound", "pounds", "#"],

  ml: ["ml", "milliliter", "milliliters", "millilitre", "millilitres", "cc"],
  l: ["l", "liter", "liters", "litre", "litres"],

  tsp: ["tsp", "teaspoon", "teaspoons"],
  tbsp: ["tbsp", "tbs", "tablespoon", "tablespoons"],
  fl_oz: ["fl oz", "fluid ounce", "fluid ounces"],
  cup: ["cup", "cups"],
  pint: ["pint", "pints", "pt"],
  quart: ["quart", "quarts", "qt"],
  gallon: ["gallon", "gallons", "gal"],
};

/**
 * Units the engine recognises but will never do arithmetic with.
 *
 * They are listed rather than lumped into `unknown` so that "2 cloves garlic"
 * can be reported as a *count* that was correctly left alone, rather than as
 * something the engine failed to read. The distinction matters to a UI, and it
 * matters to a test that wants to prove the refusal was deliberate.
 */
const COUNT_ALIASES: readonly string[] = [
  "clove",
  "cloves",
  "piece",
  "pieces",
  "slice",
  "slices",
  "stick",
  "sticks",
  "sprig",
  "sprigs",
  "head",
  "heads",
  "bunch",
  "bunches",
  "can",
  "cans",
  "tin",
  "tins",
  "packet",
  "packets",
  "package",
  "packages",
];

/** Amounts a creator left to the cook. Never numeric, never converted. */
const DESCRIPTIVE_ALIASES: readonly string[] = [
  "to taste",
  "pinch",
  "pinches",
  "dash",
  "dashes",
  "splash",
  "splashes",
  "handful",
  "handfuls",
  "drizzle",
  "glug",
];

export interface UnitClassification {
  /** The canonical unit, or null when the text is not a convertible unit. */
  readonly unit: ConvertibleUnit | null;
  readonly kind: MeasurementKind;
  readonly system: UnitSystem;
  /** The normalised lookup key, for diagnostics and tests. */
  readonly normalised: string;
}

type Entry = Omit<UnitClassification, "normalised">;

const TABLE: ReadonlyMap<string, Entry> = buildTable();

function buildTable(): ReadonlyMap<string, Entry> {
  const table = new Map<string, Entry>();

  const add = (alias: string, entry: Entry): void => {
    const key = normaliseUnitText(alias);
    // A collision means two families claim the same word, which would make
    // classification depend on table order. Fail at module load, not in a
    // recipe.
    if (table.has(key)) throw new Error(`Duplicate unit alias "${key}".`);
    table.set(key, entry);
  };

  for (const [id, aliases] of Object.entries(CONVERTIBLE_ALIASES) as ReadonlyArray<
    readonly [ConvertibleUnit, readonly string[]]
  >) {
    const definition = UNIT_DEFINITIONS[id];
    for (const alias of aliases) {
      add(alias, { unit: id, kind: definition.kind, system: definition.system });
    }
  }

  for (const alias of COUNT_ALIASES) add(alias, { unit: null, kind: "count", system: "neutral" });
  for (const alias of DESCRIPTIVE_ALIASES) {
    add(alias, { unit: null, kind: "descriptive", system: "neutral" });
  }

  return table;
}

const UNKNOWN: Entry = { unit: null, kind: "unknown", system: "unknown" };

/**
 * A bare number with no unit at all — "4" large eggs. It is a count, and a
 * count is neutral: converting it to another system is meaningless rather than
 * merely unsupported.
 */
const BARE_COUNT: Entry = { unit: null, kind: "count", system: "neutral" };

/**
 * Classifies a raw unit string from the canonical model.
 *
 * `null` — the creator wrote no unit — is a count, not an error. Anything the
 * table does not contain is `unknown`, and the caller must not convert it.
 */
export function classifyUnit(raw: string | null): UnitClassification {
  if (raw === null) return { ...BARE_COUNT, normalised: "" };

  const normalised = normaliseUnitText(raw);
  if (normalised.length === 0) return { ...UNKNOWN, normalised };

  return { ...(TABLE.get(normalised) ?? UNKNOWN), normalised };
}

/** Every alias key the table knows, for tests and for documentation. */
export function knownAliases(): readonly string[] {
  return [...TABLE.keys()].sort();
}
