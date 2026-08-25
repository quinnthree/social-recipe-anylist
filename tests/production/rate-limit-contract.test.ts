import { describe, expect, it } from "vitest";

import { DEFAULT_LIMITS, consumerQuota, registrationLimits, resolveLimits } from "../../src/http/limits.js";
import { MemoryRateLimitStore } from "../../src/ratelimit/memory-store.js";
import { limitKey } from "../../src/ratelimit/store.js";
import { runRateLimitStoreConformance } from "./rate-limit-contract.js";

describe("rate limit store conformance (in-process store)", () => {
  runRateLimitStoreConformance({ createStore: () => new MemoryRateLimitStore() });
});

describe("the approved limits (ADR-027)", () => {
  it("matches the contract's defaults", () => {
    expect(DEFAULT_LIMITS.registrationPerIpHour).toBe(5);
    expect(DEFAULT_LIMITS.registrationPerIpDay).toBe(20);
    expect(DEFAULT_LIMITS.importsPerClientDay).toBe(20);
    expect(DEFAULT_LIMITS.exportsPerClientDay).toBe(40);
  });

  it("carries a global registration ceiling that does not depend on addresses", () => {
    const global = registrationLimits(DEFAULT_LIMITS, "203.0.113.9").find(
      (rule) => rule.scope === "register:global:minute",
    );

    expect(global?.subject).toBe("global");
    expect(global?.limit).toBe(DEFAULT_LIMITS.registrationGlobalMinute);
  });

  it("is configurable, and ignores nonsense", () => {
    const limits = resolveLimits({
      REGISTRATION_LIMIT_PER_IP_HOUR: "2",
      CONSUMER_IMPORT_LIMIT_PER_DAY: "0",
      CONSUMER_EXPORT_LIMIT_PER_DAY: "not-a-number",
    });

    expect(limits.registrationPerIpHour).toBe(2);
    // Zero and nonsense fall back rather than silently disabling a limit.
    expect(limits.importsPerClientDay).toBe(DEFAULT_LIMITS.importsPerClientDay);
    expect(limits.exportsPerClientDay).toBe(DEFAULT_LIMITS.exportsPerClientDay);
  });

  it("charges all three registration limits together", () => {
    const rules = registrationLimits(DEFAULT_LIMITS, "203.0.113.9");

    expect(rules.map((rule) => rule.scope)).toEqual([
      "register:ip:hour",
      "register:ip:day",
      "register:global:minute",
    ]);
  });

  it("meters only the two consumer routes", () => {
    expect(consumerQuota(DEFAULT_LIMITS, "/api/imports", "c")?.limit).toBe(20);
    expect(consumerQuota(DEFAULT_LIMITS, "/api/exports/anylist", "c")?.limit).toBe(40);
    expect(consumerQuota(DEFAULT_LIMITS, "/api/import", "c")).toBeNull();
    expect(consumerQuota(DEFAULT_LIMITS, "/health", "c")).toBeNull();
  });
});

describe("counter keys", () => {
  it("namespaces, versions, and windows the key", () => {
    const descriptor = { scope: "register:ip:hour", subject: "203.0.113.9", limit: 5, windowSeconds: 3600 };
    const key = limitKey(descriptor, 1_700_000_000_000);

    expect(key.startsWith("ratelimit:v1:register:ip:hour:203.0.113.9:")).toBe(true);
    // The window index is part of the key, so expiry is cleanup rather than
    // correctness: a stale counter is simply never read again.
    expect(limitKey(descriptor, 1_700_000_000_000 + 3_600_000)).not.toBe(key);
  });
});
