import { createHash } from "node:crypto";

/**
 * A stable UUID for a test label.
 *
 * `Idempotency-Key` must be UUID-shaped (`src/http/requests.ts`), which the
 * native client already satisfies. Tests, however, were written with readable
 * keys like `"k1"` — and those keys carry meaning: whether two requests share a
 * key is usually the thing under test.
 *
 * Deriving the UUID from the label keeps both properties. The same label always
 * produces the same key, different labels always produce different ones, and
 * the call sites still read as `"k1"` and `"k2"` rather than as two opaque
 * constants a reader has to compare character by character.
 *
 * Deterministic on purpose: a random key per run would make a failure
 * unreproducible.
 */
export function idempotencyKeyFor(label: string): string {
  const hex = createHash("sha256").update(`idempotency-key:${label}`).digest("hex");

  // Laid out as 8-4-4-4-12. Version and variant bits are not forced: the
  // validator checks shape, not provenance, and pretending these are v4 would
  // claim an entropy source they do not have.
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
