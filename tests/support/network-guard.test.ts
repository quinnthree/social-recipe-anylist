import { describe, expect, it, vi } from "vitest";

import { BLOCKED_MESSAGE, createFetchGuard, upstashOrigin } from "./network-guard.js";

/**
 * The network boundary, exercised entirely offline: the delegate is a spy, so
 * nothing here can reach a host even if the guard let it through.
 */

const UPSTASH_URL = "https://example-12345.upstash.io";
const TOKEN = "UPSTASH-TOKEN-LEAK-CHECK-9f2a";

const LIVE = { QA_LIVE_EXTERNAL: "1", KV_REST_API_URL: UPSTASH_URL, KV_REST_API_TOKEN: TOKEN };

function guard(env: NodeJS.ProcessEnv) {
  const delegate = vi.fn(async () => new Response("ok"));

  return { fetch: createFetchGuard({ env, delegate: delegate as unknown as typeof fetch }), delegate };
}

/**
 * Catches both shapes. Normal mode throws synchronously — the behaviour the
 * original blocker had, and preserved deliberately — while a live-mode refusal
 * rejects, because that path is `async` like real fetch.
 */
async function refusalFor(env: NodeJS.ProcessEnv, url: string): Promise<Error> {
  const { fetch: guarded, delegate } = guard(env);
  let error: Error | null = null;

  try {
    await guarded(url);
  } catch (thrown) {
    error = thrown as Error;
  }

  expect(error).not.toBeNull();
  expect(delegate).not.toHaveBeenCalled();

  return error as Error;
}

describe("normal mode", () => {
  it("blocks everything, including Upstash", async () => {
    // Unchanged behaviour: without the flag there is no exception at all, even
    // for the host the live suites would use.
    const env = { KV_REST_API_URL: UPSTASH_URL, KV_REST_API_TOKEN: TOKEN };

    expect((await refusalFor(env, UPSTASH_URL)).message).toBe(BLOCKED_MESSAGE);
    expect((await refusalFor(env, "https://api.anthropic.com/v1/messages")).message).toBe(
      BLOCKED_MESSAGE,
    );
  });

  it("still throws synchronously, as the original blocker did", () => {
    const { fetch: guarded } = guard({});

    // Preserved rather than modernised: existing tests catch this shape, and
    // normal mode is explicitly not what this correction changes.
    expect(() => guarded("https://example.com")).toThrow(BLOCKED_MESSAGE);
  });

  it("is not enabled by anything other than an explicit 1", async () => {
    for (const flag of ["0", "true", "yes", ""]) {
      const error = await refusalFor({ ...LIVE, QA_LIVE_EXTERNAL: flag }, UPSTASH_URL);
      expect(error.message).toBe(BLOCKED_MESSAGE);
    }
  });
});

describe("live mode permits exactly one origin", () => {
  it("allows the configured Upstash endpoint", async () => {
    const { fetch: guarded, delegate } = guard(LIVE);

    await guarded(`${UPSTASH_URL}/pipeline`);

    expect(delegate).toHaveBeenCalledTimes(1);
  });

  it("accepts a URL object and a Request-like input", async () => {
    const { fetch: guarded, delegate } = guard(LIVE);

    await guarded(new URL(`${UPSTASH_URL}/get/key`));
    await guarded({ url: `${UPSTASH_URL}/set/key` } as unknown as Request);

    expect(delegate).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["an arbitrary host", "https://example.com/anything"],
    ["Anthropic", "https://api.anthropic.com/v1/messages"],
    ["Apify", "https://api.apify.com/v2/acts"],
    ["AnyList", "https://www.anylist.com/data/user-data/get"],
    ["TikTok", "https://www.tiktok.com/oembed?url=x"],
  ])("blocks %s", async (_label, url) => {
    expect((await refusalFor(LIVE, url)).message).toContain("is not it");
  });

  it("blocks a host that merely starts with the configured one", async () => {
    // The reason this compares origins rather than string prefixes.
    const spoof = `${UPSTASH_URL}.evil.test/pipeline`;

    expect((await refusalFor(LIVE, spoof)).message).toContain("evil.test");
  });

  it("blocks a subdomain of the configured host", async () => {
    await refusalFor(LIVE, "https://sneaky.example-12345.upstash.io/pipeline");
  });

  it.each([
    ["a different scheme", "http://example-12345.upstash.io/pipeline"],
    ["a different port", "https://example-12345.upstash.io:8443/pipeline"],
    ["a different host", "https://example-99999.upstash.io/pipeline"],
  ])("blocks %s, because an origin is scheme, host, and port together", async (_label, url) => {
    await refusalFor(LIVE, url);
  });

  it("blocks a destination it cannot parse", async () => {
    // Unverifiable is not permitted: relative and malformed inputs fail closed.
    expect((await refusalFor(LIVE, "/relative/path")).message).toContain("unreadable");
    expect((await refusalFor(LIVE, "not a url at all")).message).toContain("unreadable");
  });

  it("refuses redirects rather than following them somewhere else", async () => {
    const { fetch: guarded, delegate } = guard(LIVE);

    await guarded(`${UPSTASH_URL}/pipeline`, { method: "POST" });

    // A permitted request must not become an escape hatch by being redirected.
    expect(delegate).toHaveBeenCalledWith(`${UPSTASH_URL}/pipeline`, {
      method: "POST",
      redirect: "error",
    });
  });
});

describe("a misconfiguration never widens the boundary", () => {
  it.each([
    ["no URL at all", { QA_LIVE_EXTERNAL: "1", KV_REST_API_TOKEN: TOKEN }],
    ["a blank URL", { ...LIVE, KV_REST_API_URL: "   " }],
    ["an unparseable URL", { ...LIVE, KV_REST_API_URL: "not-a-url" }],
    ["a non-http scheme", { ...LIVE, KV_REST_API_URL: "redis://example.upstash.io" }],
  ])("blocks everything given %s", async (_label, env) => {
    expect((await refusalFor(env, UPSTASH_URL)).message).toBe(BLOCKED_MESSAGE);
    expect((await refusalFor(env, "https://example.com")).message).toBe(BLOCKED_MESSAGE);
  });

  it("accepts either naming convention", () => {
    expect(upstashOrigin({ UPSTASH_REDIS_REST_URL: UPSTASH_URL })).toBe(UPSTASH_URL);
    expect(upstashOrigin({ KV_REST_API_URL: UPSTASH_URL })).toBe(UPSTASH_URL);
    expect(upstashOrigin({})).toBeNull();
  });
});

describe("secret safety", () => {
  it("never puts a credential in a refusal", async () => {
    const error = await refusalFor(LIVE, "https://example.com/anything");

    expect(error.message).not.toContain(TOKEN);
    // Nor the configured endpoint: only the destination that was refused.
    expect(error.message).not.toContain("upstash.io");
  });

  it("names only the refused destination's host, not its path or query", async () => {
    const error = await refusalFor(LIVE, "https://example.com/path?token=SHOULD-NOT-APPEAR");

    expect(error.message).toContain("example.com");
    expect(error.message).not.toContain("SHOULD-NOT-APPEAR");
    expect(error.message).not.toContain("/path");
  });
});
