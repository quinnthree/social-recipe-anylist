/**
 * A pure, fail-closed parser for the quantity strings recipes actually use.
 *
 * Two rules govern everything here:
 *
 * 1. **It never guesses.** "about two", "a handful", "to taste", and a
 *    malformed fraction all return `null`. `null` means "no calculated
 *    conversion", never "assume something reasonable".
 * 2. **It never rewrites the source.** The canonical `quantity` string stays
 *    exactly as the creator wrote it. This produces a *separate* numeric
 *    reading for the engine's own arithmetic and hands the original back
 *    untouched.
 */

/** A parsed quantity: a single value, or a stated range. */
export type ParsedQuantity =
  | { readonly kind: "exact"; readonly value: number }
  | { readonly kind: "range"; readonly min: number; readonly max: number };

/**
 * The Unicode vulgar fractions that appear in real captions. Listed exactly —
 * a codepoint not in this table is not a fraction as far as the engine is
 * concerned.
 */
const VULGAR_FRACTIONS: ReadonlyMap<string, number> = new Map([
  ["¼", 1 / 4], // ¼
  ["½", 1 / 2], // ½
  ["¾", 3 / 4], // ¾
  ["⅐", 1 / 7], // ⅐
  ["⅑", 1 / 9], // ⅑
  ["⅒", 1 / 10], // ⅒
  ["⅓", 1 / 3], // ⅓
  ["⅔", 2 / 3], // ⅔
  ["⅕", 1 / 5], // ⅕
  ["⅖", 2 / 5], // ⅖
  ["⅗", 3 / 5], // ⅗
  ["⅘", 4 / 5], // ⅘
  ["⅙", 1 / 6], // ⅙
  ["⅚", 5 / 6], // ⅚
  ["⅛", 1 / 8], // ⅛
  ["⅜", 3 / 8], // ⅜
  ["⅝", 5 / 8], // ⅝
  ["⅞", 7 / 8], // ⅞
]);

const VULGAR_CLASS = [...VULGAR_FRACTIONS.keys()].join("");

/** `2-3`, `2–3`, `2—3`, `2 to 3`. A hyphen inside a number never reaches here. */
const RANGE_SEPARATOR = /\s*(?:-|‐|‑|‒|–|—|―|~)\s*|\s+to\s+/;

/** `400`, `3.5`, `.5` is rejected — a leading digit is required. */
const DECIMAL = /^\d+(?:\.\d+)?$/;

/** `1/2`, `3/4`. Both parts must be digits; the denominator must be positive. */
const FRACTION = /^(\d+)\s*\/\s*(\d+)$/;

/** `1 1/2` — an integer followed by a fraction. */
const MIXED_ASCII = /^(\d+)\s+(\d+)\s*\/\s*(\d+)$/;

/** `1½` — an integer immediately followed by a vulgar fraction. */
const MIXED_VULGAR = new RegExp(`^(\\d+)\\s*([${VULGAR_CLASS}])$`);

/** `½` alone. */
const BARE_VULGAR = new RegExp(`^([${VULGAR_CLASS}])$`);

/**
 * Reads one quantity string.
 *
 * Returns `null` for anything not covered by the grammar above, including
 * prose, an empty string, a zero or negative amount, and a fraction over zero.
 */
export function parseQuantity(raw: string | null): ParsedQuantity | null {
  if (raw === null) return null;

  const text = raw.trim();
  if (text.length === 0) return null;

  const parts = text.split(RANGE_SEPARATOR);

  // An empty part means the separator had nothing on one side of it. Dropping
  // those instead would make "-3" parse as 3: the leading hyphen would read as
  // a range separator, the empty left side would vanish, and a negative
  // quantity would come back positive.
  if (parts.some((part) => part.length === 0)) return null;

  // More than two parts is not a range anyone stated; it is something else.
  if (parts.length === 2) {
    const min = parseScalar(parts[0] ?? "");
    const max = parseScalar(parts[1] ?? "");

    // A "range" whose end is not above its start is malformed, not a range.
    if (min === null || max === null || max <= min) return null;

    return { kind: "range", min, max };
  }

  if (parts.length !== 1) return null;

  const value = parseScalar(parts[0] ?? "");
  return value === null ? null : { kind: "exact", value };
}

/** One value: integer, decimal, fraction, or mixed number. Never a range. */
function parseScalar(raw: string): number | null {
  const text = raw.trim();
  if (text.length === 0) return null;

  const mixedAscii = MIXED_ASCII.exec(text);
  if (mixedAscii) {
    const whole = Number(mixedAscii[1]);
    const fraction = divide(mixedAscii[2], mixedAscii[3]);
    return fraction === null ? null : positive(whole + fraction);
  }

  const mixedVulgar = MIXED_VULGAR.exec(text);
  if (mixedVulgar) {
    const whole = Number(mixedVulgar[1]);
    const fraction = VULGAR_FRACTIONS.get(mixedVulgar[2] ?? "");
    return fraction === undefined ? null : positive(whole + fraction);
  }

  const bareVulgar = BARE_VULGAR.exec(text);
  if (bareVulgar) {
    const fraction = VULGAR_FRACTIONS.get(bareVulgar[1] ?? "");
    return fraction === undefined ? null : positive(fraction);
  }

  const fraction = FRACTION.exec(text);
  if (fraction) {
    const value = divide(fraction[1], fraction[2]);
    return value === null ? null : positive(value);
  }

  if (DECIMAL.test(text)) return positive(Number(text));

  return null;
}

/** A fraction, refusing a zero denominator rather than producing Infinity. */
function divide(numerator: string | undefined, denominator: string | undefined): number | null {
  if (numerator === undefined || denominator === undefined) return null;

  const bottom = Number(denominator);
  if (!Number.isFinite(bottom) || bottom <= 0) return null;

  return Number(numerator) / bottom;
}

/** Zero and negative amounts are not quantities anyone wrote on purpose. */
function positive(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}
