import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Consumer installation tokens (ADR-026, `contracts.md` Part 3).
 *
 *     sr1_<clientId>_<secret>
 *
 * `clientId` is public: it is the store lookup key, the operational log
 * identifier, and the principal quotas and revocation are keyed on. `secret` is
 * the credential. Only its digest is ever persisted.
 */

/** Format and version. A future shape is `sr2_`, never a mutation of this one. */
export const TOKEN_PREFIX = "sr1_";

export const CLIENT_ID_BYTES = 16;
export const SECRET_BYTES = 32;

/** base64url of N bytes, unpadded: ceil(N * 4 / 3). */
const CLIENT_ID_LENGTH = 22;
const SECRET_LENGTH = 43;

const SEPARATOR = "_";
const SEPARATOR_INDEX = TOKEN_PREFIX.length + CLIENT_ID_LENGTH;
export const TOKEN_LENGTH = SEPARATOR_INDEX + SEPARATOR.length + SECRET_LENGTH;

/** The base64url alphabet. Note that it contains the separator. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const DIGEST_LENGTH = 64;
const HEX = /^[0-9a-f]+$/;

export interface ParsedToken {
  clientId: string;
  /** Present only in flight. Never stored, never logged. */
  secret: string;
}

export interface MintedCredential {
  clientId: string;
  /** Returned to the client once, at issuance, and never recoverable after. */
  token: string;
  /** The only part that is persisted. */
  secretHash: string;
}

export function mintClientId(): string {
  return randomBytes(CLIENT_ID_BYTES).toString("base64url");
}

export function mintSecret(): string {
  return randomBytes(SECRET_BYTES).toString("base64url");
}

export function buildToken(clientId: string, secret: string): string {
  return `${TOKEN_PREFIX}${clientId}${SEPARATOR}${secret}`;
}

/**
 * A fresh credential: the token to hand back, and the digest to store.
 *
 * The raw secret is deliberately not returned on its own. Everything a caller
 * needs is here, so nothing has a reason to hold the secret separately.
 */
export function mintCredential(): MintedCredential {
  const clientId = mintClientId();
  const secret = mintSecret();

  return {
    clientId,
    token: buildToken(clientId, secret),
    secretHash: hashSecret(secret),
  };
}

/**
 * Parse strictly, or reject.
 *
 * **Parsing is positional, not delimiter-split**, and that is load-bearing:
 * `_` is a member of the base64url alphabet, so both the clientId and the
 * secret can legitimately contain the separator. Splitting on it would reject
 * roughly one token in three. Both components are fixed length, so position
 * resolves the ambiguity that splitting cannot.
 *
 * Returns `null` rather than throwing, and the returned object is the only
 * thing that ever carries the secret — no error, message, or diagnostic
 * derived from this function includes any part of the input.
 */
export function parseToken(value: unknown): ParsedToken | null {
  if (typeof value !== "string") return null;
  if (value.length !== TOKEN_LENGTH) return null;
  if (!value.startsWith(TOKEN_PREFIX)) return null;
  if (value[SEPARATOR_INDEX] !== SEPARATOR) return null;

  const clientId = value.slice(TOKEN_PREFIX.length, SEPARATOR_INDEX);
  const secret = value.slice(SEPARATOR_INDEX + SEPARATOR.length);

  if (!isCanonicalBase64Url(clientId, CLIENT_ID_BYTES)) return null;
  if (!isCanonicalBase64Url(secret, SECRET_BYTES)) return null;

  return { clientId, secret };
}

/** Whether a value could be a clientId. Used for store lookups, not for auth. */
export function isClientId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === CLIENT_ID_LENGTH &&
    isCanonicalBase64Url(value, CLIENT_ID_BYTES)
  );
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function isSecretHash(value: unknown): value is string {
  return typeof value === "string" && value.length === DIGEST_LENGTH && HEX.test(value);
}

/**
 * Constant-time verification of a supplied secret against a stored digest.
 *
 * Both sides are hashed again to a fixed 32 bytes before comparison, the same
 * construction `isAuthorized` uses for `RECIPE_API_KEY`: `timingSafeEqual`
 * throws on a length mismatch, and hashing first means it can never see one —
 * so a corrupted stored digest fails as a mismatch rather than as an exception
 * on the authentication path.
 */
export function verifySecret(secret: string, storedHash: string): boolean {
  const provided = createHash("sha256").update(hashSecret(secret)).digest();
  const expected = createHash("sha256").update(storedHash).digest();

  return timingSafeEqual(provided, expected);
}

/**
 * Rejects anything that is not the exact encoding of `bytes` bytes.
 *
 * `Buffer.from(_, "base64url")` is lenient: it skips characters outside the
 * alphabet and tolerates trailing bits, so decoding alone would accept
 * `"abc def"` and a value whose final character carries bits that re-encode
 * differently. Requiring the alphabet, the decoded length, **and** a stable
 * round trip closes all three.
 */
function isCanonicalBase64Url(value: string, bytes: number): boolean {
  if (!BASE64URL.test(value)) return false;

  const decoded = Buffer.from(value, "base64url");

  return decoded.length === bytes && decoded.toString("base64url") === value;
}
