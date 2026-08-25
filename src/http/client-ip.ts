/**
 * Which address a rate-limit bucket belongs to.
 *
 * This is security-sensitive: a caller who can choose their own bucket is not
 * rate limited at all, and a limit that looks enforced while being trivially
 * evaded is worse than none, because nobody goes looking for it.
 *
 * Deliberately **not** Fastify's `trustProxy`. That setting wants a hop count
 * or a trusted-address list, and specifying either means asserting a proxy
 * topology — which cannot be verified from a development machine. An explicit
 * rule can at least be tested against every topology it might meet, and it
 * leaves `request.ip` untouched for everything else.
 *
 * ## The rule, and why
 *
 * Prefer `x-vercel-forwarded-for`, which the platform sets; otherwise take the
 * **rightmost** entry of `x-forwarded-for`.
 *
 * Rightmost, not leftmost. `X-Forwarded-For` grows left to right as each proxy
 * appends the address it received from, so the leftmost entry is whatever the
 * original caller claimed — attacker-controlled, and the usual mistake. The
 * rightmost entry is what the last proxy actually observed.
 *
 * That holds whether the platform appends to a client-supplied header
 * (`"9.9.9.9, REAL"` → `REAL`) or replaces it (`"REAL"` → `REAL`). It does not
 * hold for a proxy that forwards a client's header untouched — but no
 * header-based rule survives that, and on a platform where the socket address
 * is the proxy's, neither does any other.
 *
 * **This assumption is unverified against a deployed environment and must be
 * confirmed in M5E-B4** before the per-IP limit is treated as real. The global
 * registration ceiling is deliberately independent of it.
 */

export type ClientIpStrategy = "forwarded" | "socket";

/** The platform's own header, which a client request should never be able to set. */
const VERCEL_HEADER = "x-vercel-forwarded-for";
const FORWARDED_HEADER = "x-forwarded-for";

export interface ClientIpSource {
  headers: Record<string, string | string[] | undefined>;
  /** The connecting peer. On a proxied platform this is the proxy, not the caller. */
  socketAddress: string | undefined;
}

/**
 * `socket` where nothing is in front of the process, `forwarded` behind a proxy
 * that is known to rewrite the header.
 */
export function resolveIpStrategy(env: NodeJS.ProcessEnv): ClientIpStrategy {
  const configured = env["CLIENT_IP_STRATEGY"]?.trim();
  if (configured === "forwarded" || configured === "socket") return configured;

  return env["VERCEL"] ? "forwarded" : "socket";
}

/**
 * The address to bucket a request under, or `null` when none can be
 * established.
 *
 * `null` is not "allow": the caller decides, and for registration it means the
 * request cannot be attributed and is refused rather than exempted.
 */
export function resolveClientIp(
  { headers, socketAddress }: ClientIpSource,
  strategy: ClientIpStrategy,
): string | null {
  if (strategy === "socket") return normalise(socketAddress);

  // A blank or unusable header falls through rather than resolving to nothing.
  // Every request must land in some bucket: an address we cannot read should
  // share the proxy's bucket and be limited alongside its neighbours, never be
  // exempted, and never lock out a caller behind an unusual proxy.
  const platform = rightmostOf(headers[VERCEL_HEADER]);
  if (platform !== null) return platform;

  const forwarded = rightmostOf(headers[FORWARDED_HEADER]);
  if (forwarded !== null) return forwarded;

  return normalise(socketAddress);
}

/**
 * A duplicated header arrives as an array. Node preserves order, so the last
 * occurrence is the one written closest to us — the same reasoning as
 * rightmost-within-a-value.
 */
function firstValue(header: string | string[] | undefined): string | null {
  if (Array.isArray(header)) {
    return header.length === 0 ? null : (header[header.length - 1] ?? null);
  }

  return header ?? null;
}

function rightmostOf(header: string | string[] | undefined): string | null {
  const value = firstValue(header);
  if (value === null) return null;

  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  return normalise(parts[parts.length - 1]);
}

function normalise(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) return null;

  // `::ffff:203.0.113.9` and `203.0.113.9` are the same caller and must share
  // one bucket, or an attacker could double their allowance by switching.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);

  return mapped?.[1] ?? trimmed;
}
