import { createHash } from "node:crypto";

/**
 * SHA-256 over a deterministic serialisation of the *validated, normalised*
 * request (ADR-018).
 *
 * Fingerprinting the accepted shape rather than the raw bytes is the whole
 * point: a client that re-serialises an identical recipe — a different JSON
 * encoder, a round-trip through a Shortcut, reordered keys — would otherwise
 * get `409 Idempotency key conflict` for a request that is the same by every
 * meaning that matters, and would have no way to diagnose or fix it.
 *
 * Changing `canonicalise` silently invalidates every stored fingerprint, so it
 * is versioned by the key namespace rather than edited in place.
 */
export function fingerprintOf(value: unknown): string {
  return createHash("sha256").update(canonicalise(value)).digest("hex");
}

/**
 * Deterministic JSON. Object keys are sorted, so key ordering carries no
 * meaning; array order is preserved, because it does — reordering ingredients
 * or instructions produces a different recipe.
 *
 * `undefined` is encoded as `null` rather than dropped, so an explicitly absent
 * value and a missing key cannot collide.
 */
export function canonicalise(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null) ?? "null";

  if (Array.isArray(value)) return `[${value.map(canonicalise).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalise(item)}`);

  return `{${entries.join(",")}}`;
}
