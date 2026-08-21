import { createHash } from "node:crypto";

/**
 * Redaction helpers for AnyList session research.
 *
 * Rule: nothing in this module ever returns a substring of a secret. Everything
 * it emits is either a length, a character-class summary, or a one-way hash
 * prefix. That makes experiment output safe to paste into a document or a
 * terminal transcript while still letting us answer the questions that matter —
 * "did this value change?", "is it a JWT?", "how long is it?".
 */

/** Characters we are willing to name in output, because they carry no entropy. */
const CHARSET_PROBES = [
  { name: "lower", pattern: /[a-z]/ },
  { name: "upper", pattern: /[A-Z]/ },
  { name: "digit", pattern: /[0-9]/ },
  { name: "dash", pattern: /-/ },
  { name: "underscore", pattern: /_/ },
  { name: "dot", pattern: /\./ },
  { name: "other", pattern: /[^A-Za-z0-9\-_.]/ },
] as const;

/**
 * A stable, non-reversible identity for a secret. Twelve hex characters of
 * SHA-256 is far too little to attack the preimage and far more than enough to
 * tell two tokens apart across processes and across runs.
 */
export function fingerprint(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 12);
}

export interface SecretShape {
  length: number;
  charset: string;
  segments: number;
  fingerprint: string;
}

/** Everything we are prepared to say about an opaque credential. */
export function describeSecret(secret: string): SecretShape {
  return {
    length: secret.length,
    charset: CHARSET_PROBES.filter((probe) => probe.pattern.test(secret))
      .map((probe) => probe.name)
      .join("+"),
    segments: secret.split(".").length,
    fingerprint: fingerprint(secret),
  };
}

export interface JwtClaimSummary {
  isJwt: boolean;
  /** Claim names only. Claim *values* are withheld except the numeric time claims. */
  headerKeys: string[];
  payloadKeys: string[];
  /** Unix seconds, when present. These are the only claim values we print. */
  issuedAt: number | null;
  expiresAt: number | null;
  notBefore: number | null;
  lifetimeSeconds: number | null;
}

const TIME_CLAIMS = { iat: "issuedAt", exp: "expiresAt", nbf: "notBefore" } as const;

/**
 * Reports whether a credential is a readable JWT and, if so, its expiry claims.
 *
 * This is the one thing that can answer "how long does a session last?" without
 * waiting out the session. Identity claims (sub, email, user ids) are named but
 * never valued — knowing the claim exists is the finding; its content is not.
 */
export function summariseJwtClaims(token: string): JwtClaimSummary {
  const empty: JwtClaimSummary = {
    isJwt: false,
    headerKeys: [],
    payloadKeys: [],
    issuedAt: null,
    expiresAt: null,
    notBefore: null,
    lifetimeSeconds: null,
  };

  const parts = token.split(".");
  if (parts.length !== 3) return empty;

  const header = decodeSegment(parts[0]);
  const payload = decodeSegment(parts[1]);
  if (header === null || payload === null) return empty;

  const summary: JwtClaimSummary = {
    ...empty,
    isJwt: true,
    headerKeys: Object.keys(header).sort(),
    payloadKeys: Object.keys(payload).sort(),
  };

  for (const [claim, field] of Object.entries(TIME_CLAIMS)) {
    const value = payload[claim];
    if (typeof value === "number") summary[field] = value;
  }

  if (summary.issuedAt !== null && summary.expiresAt !== null) {
    summary.lifetimeSeconds = summary.expiresAt - summary.issuedAt;
  }

  return summary;
}

function decodeSegment(segment: string | undefined): Record<string, unknown> | null {
  if (segment === undefined) return null;

  try {
    const json = Buffer.from(segment, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Last line of defence. Experiment scripts route every printed line through
 * this, so a token that reaches stdout by mistake is masked rather than logged.
 * Registered secrets are matched longest-first so a token that contains another
 * is not partially unmasked.
 */
export class OutputGuard {
  private readonly secrets: string[] = [];

  register(...secrets: readonly (string | null | undefined)[]): void {
    for (const secret of secrets) {
      // Below 8 characters a "secret" is more likely to be a substring of
      // ordinary text, and masking it would corrupt the output it protects.
      if (typeof secret === "string" && secret.length >= 8 && !this.secrets.includes(secret)) {
        this.secrets.push(secret);
      }
    }
    this.secrets.sort((a, b) => b.length - a.length);
  }

  scrub(text: string): string {
    return this.secrets.reduce(
      (masked, secret) => masked.split(secret).join(`[redacted:${fingerprint(secret)}]`),
      text,
    );
  }

  log(...parts: readonly unknown[]): void {
    const line = parts.map((part) => (typeof part === "string" ? part : format(part))).join(" ");
    console.log(this.scrub(line));
  }
}

function format(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}
