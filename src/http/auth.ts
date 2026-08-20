import { createHash, timingSafeEqual } from "node:crypto";

const BEARER = "Bearer ";

/**
 * Constant-time bearer check. Both sides are hashed to a fixed 32 bytes first,
 * so timingSafeEqual never sees a length mismatch and the comparison leaks
 * neither the key's contents nor its length.
 */
export function isAuthorized(header: string | undefined, secret: string): boolean {
  if (header === undefined || !header.startsWith(BEARER)) return false;

  const provided = createHash("sha256").update(header.slice(BEARER.length)).digest();
  const expected = createHash("sha256").update(secret).digest();

  return timingSafeEqual(provided, expected);
}
