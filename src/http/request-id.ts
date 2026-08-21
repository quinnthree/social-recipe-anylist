import { randomBytes } from "node:crypto";

/** Crockford base32: no I, L, O, or U, so a transcribed id cannot be misread. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const PREFIX = "req_";
const TIMESTAMP_BYTES = 6;
const RANDOM_BYTES = 10;

/**
 * A client-supplied identifier we are willing to echo back. Deliberately narrow:
 * the value ends up in log lines and response headers, so it may not carry
 * whitespace, control characters, or header delimiters.
 */
const ADOPTABLE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * A ULID with a `req_` prefix: 48 bits of millisecond timestamp followed by 80
 * random bits, Crockford base32. Sorts by creation time, which makes a log dump
 * chronological without a separate timestamp field.
 *
 * Written here rather than taken as a dependency — it is twenty lines, and the
 * project adds dependencies only when they are actually needed.
 */
export function generateRequestId(now: number = Date.now()): string {
  const bytes = Buffer.alloc(TIMESTAMP_BYTES + RANDOM_BYTES);
  bytes.writeUIntBE(now, 0, TIMESTAMP_BYTES);
  randomBytes(RANDOM_BYTES).copy(bytes, TIMESTAMP_BYTES);

  return PREFIX + encodeBase32(bytes);
}

/**
 * Adopts the client's `X-Request-Id` when it is safe to echo, otherwise issues
 * our own.
 *
 * A malformed trace header never fails the request: correlation is a
 * convenience, and rejecting a valid import because its tracing header was
 * badly formed would trade a working feature for a cosmetic one. The caller
 * records which branch was taken, so a forged or repeated id stays visible.
 */
export function resolveRequestId(header: unknown): {
  requestId: string;
  source: "client" | "generated";
} {
  const candidate = Array.isArray(header) ? header[0] : header;

  if (typeof candidate === "string" && ADOPTABLE.test(candidate)) {
    return { requestId: candidate, source: "client" };
  }

  return { requestId: generateRequestId(), source: "generated" };
}

/** Big-endian base32 over the whole buffer. 16 bytes in, 26 characters out. */
function encodeBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      bits -= 5;
      output += ALPHABET[(value >>> bits) & 31];
    }
  }

  // 128 bits is not a multiple of 5; pad the trailing 3 bits into a final char.
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];

  return output;
}
