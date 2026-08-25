import { liveExternalRequested } from "../live/prerequisites.js";

/**
 * The network boundary for the test process.
 *
 * Normally there is no boundary to speak of: every external call is blocked, so
 * an accidental request to TikTok, Anthropic, or AnyList is a loud failure
 * rather than a slow, flaky, occasionally-charged test run.
 *
 * The live external suites need one exception, and exactly one. They exist to
 * verify the Redis implementation that actually runs in production, which
 * cannot be done against a stub — but the command that runs them injects the
 * **production** environment, so the same process is holding live Anthropic,
 * AnyList, and Apify credentials at the time. Opening the network wholesale for
 * `QA_LIVE_EXTERNAL=1` would put those one accidental `fetch` away from being
 * spent, and a test suite is not a place to discover that.
 *
 * So live mode permits the configured Upstash origin and nothing else.
 */

export const BLOCKED_MESSAGE =
  "Live network access is blocked in tests. Inject a fake at the boundary instead.";

const URL_VARIABLES = ["KV_REST_API_URL", "UPSTASH_REDIS_REST_URL"] as const;

export interface FetchGuardOptions {
  env?: NodeJS.ProcessEnv;
  /** The real fetch. Injected so the guard can be tested without one. */
  delegate: typeof fetch;
}

/**
 * The configured Upstash origin, or `null`.
 *
 * `null` is never "allow": a missing or unparseable URL leaves the guard
 * blocking everything, so a misconfiguration cannot widen the boundary.
 */
export function upstashOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const name of URL_VARIABLES) {
    const raw = (env[name] ?? "").trim();
    if (raw.length === 0) continue;

    try {
      const { origin, protocol } = new URL(raw);
      if (protocol !== "https:" && protocol !== "http:") return null;

      return origin;
    } catch {
      return null;
    }
  }

  return null;
}

export function createFetchGuard({ env = process.env, delegate }: FetchGuardOptions): typeof fetch {
  if (!liveExternalRequested(env)) return blockEverything;

  const allowed = upstashOrigin(env);
  if (allowed === null) return blockEverything;

  const guarded = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const destination = destinationOf(input);

    // Unparseable means unverifiable, and unverifiable means blocked.
    if (destination === null) throw refusal("an unreadable destination");

    // Origin comparison, never a prefix test: `https://x.upstash.io.evil.test`
    // starts with the configured URL and is a different host entirely. Origin
    // covers scheme, host, and port together, which is exactly the comparison
    // that matters.
    if (destination.origin !== allowed) throw refusal(destination.hostname);

    // A permitted request must not become an escape hatch by being redirected
    // somewhere else. Refusing redirects outright is the smallest enforcement
    // that actually holds: the Upstash REST API answers directly, so a redirect
    // here is a surprise worth failing on rather than following.
    return delegate(input, { ...init, redirect: "error" });
  };

  return guarded as typeof fetch;
}

/** Replaces `globalThis.fetch`, capturing the real one first. */
export function installNetworkGuard(env: NodeJS.ProcessEnv = process.env): void {
  const native = globalThis.fetch;

  globalThis.fetch = createFetchGuard({ env, delegate: native });
}

function blockEverything(): never {
  throw new Error(BLOCKED_MESSAGE);
}

/**
 * Names the destination that was refused, and nothing else.
 *
 * The hostname is the diagnostic; the configured endpoint and every credential
 * stay out of it. A message about blocked network access is not a place to put
 * either.
 */
function refusal(destination: string): Error {
  return new Error(
    `${BLOCKED_MESSAGE} Only the configured Upstash endpoint is reachable while ` +
      `QA_LIVE_EXTERNAL=1, and ${destination} is not it.`,
  );
}

function destinationOf(input: Parameters<typeof fetch>[0]): URL | null {
  try {
    if (typeof input === "string") return new URL(input);
    if (input instanceof URL) return new URL(input.href);

    const { url } = input as { url?: unknown };

    return typeof url === "string" ? new URL(url) : null;
  } catch {
    return null;
  }
}
