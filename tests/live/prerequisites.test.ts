import { describe, expect, it } from "vitest";

import {
  LiveExternalConfigurationError,
  liveExternalRequested,
  missingUpstashVariables,
  requireLiveUpstash,
  upstashConfigured,
} from "./prerequisites.js";

/**
 * The gate itself, exercised offline. Nothing here contacts Upstash — these are
 * pure functions over an injected environment, which is why they can be part of
 * the normal suite.
 */

const URL_NAMES = "KV_REST_API_URL or UPSTASH_REDIS_REST_URL";
const TOKEN_NAMES = "KV_REST_API_TOKEN or UPSTASH_REDIS_REST_TOKEN";

const CONFIGURED = {
  KV_REST_API_URL: "https://example.upstash.invalid",
  KV_REST_API_TOKEN: "token-value-never-asserted-on",
};

describe("without the flag", () => {
  it("stays skipped, however the environment is configured", () => {
    // Unchanged behaviour, and the property that keeps the normal run offline.
    expect(requireLiveUpstash({})).toBe(false);
    expect(requireLiveUpstash(CONFIGURED)).toBe(false);
    expect(requireLiveUpstash({ QA_LIVE_EXTERNAL: "0", ...CONFIGURED })).toBe(false);
    expect(requireLiveUpstash({ QA_LIVE_EXTERNAL: "true" })).toBe(false);
  });

  it("recognises only an explicit 1 as a request to run", () => {
    expect(liveExternalRequested({ QA_LIVE_EXTERNAL: "1" })).toBe(true);
    expect(liveExternalRequested({ QA_LIVE_EXTERNAL: "yes" })).toBe(false);
    expect(liveExternalRequested({})).toBe(false);
  });
});

describe("with the flag and no credentials", () => {
  it("fails instead of skipping", () => {
    // The defect this replaces: the run exited 0 having verified nothing, and
    // a verification gate was read from that exit code.
    expect(() => requireLiveUpstash({ QA_LIVE_EXTERNAL: "1" })).toThrow(
      LiveExternalConfigurationError,
    );
  });

  it("names every missing variable, and both accepted spellings", () => {
    const error = attempt({ QA_LIVE_EXTERNAL: "1" });

    expect(error?.message).toContain(URL_NAMES);
    expect(error?.message).toContain(TOKEN_NAMES);
  });

  it("names only the half that is missing", () => {
    const error = attempt({ QA_LIVE_EXTERNAL: "1", UPSTASH_REDIS_REST_URL: "https://x.invalid" });

    expect(error?.message).not.toContain(URL_NAMES);
    expect(error?.message).toContain(TOKEN_NAMES);
  });

  it("treats a blank value as absent", () => {
    // An empty variable is not a credential and must not read as one.
    const error = attempt({ QA_LIVE_EXTERNAL: "1", ...CONFIGURED, KV_REST_API_TOKEN: "   " });

    expect(error?.message).toContain(TOKEN_NAMES);
  });

  it("never puts a credential value in the message", () => {
    const secret = "UPSTASH-VALUE-LEAK-CHECK-9f2a";
    const error = attempt({ QA_LIVE_EXTERNAL: "1", KV_REST_API_URL: secret });

    expect(error).not.toBeNull();
    expect(error?.message).not.toContain(secret);
  });

  it("explains why a missing configuration is a failure and not a skip", () => {
    expect(attempt({ QA_LIVE_EXTERNAL: "1" })?.message).toContain("failed verification");
  });
});

describe("with the flag and credentials", () => {
  it("reports the suites as eligible to run", () => {
    expect(requireLiveUpstash({ QA_LIVE_EXTERNAL: "1", ...CONFIGURED })).toBe(true);
  });

  it("accepts either naming convention", () => {
    expect(
      requireLiveUpstash({
        QA_LIVE_EXTERNAL: "1",
        UPSTASH_REDIS_REST_URL: "https://example.upstash.invalid",
        UPSTASH_REDIS_REST_TOKEN: "token",
      }),
    ).toBe(true);
  });

  it("accepts a mixed pair, as the stores themselves do", () => {
    expect(
      requireLiveUpstash({
        QA_LIVE_EXTERNAL: "1",
        KV_REST_API_URL: "https://example.upstash.invalid",
        UPSTASH_REDIS_REST_TOKEN: "token",
      }),
    ).toBe(true);
  });

  it("agrees with the configuration predicate", () => {
    expect(upstashConfigured(CONFIGURED)).toBe(true);
    expect(upstashConfigured({})).toBe(false);
    expect(missingUpstashVariables(CONFIGURED)).toEqual([]);
  });
});

function attempt(env: NodeJS.ProcessEnv): Error | null {
  try {
    requireLiveUpstash(env);
    return null;
  } catch (error) {
    return error as Error;
  }
}
