import { describe, expect, it, vi } from "vitest";

import { CONSUME_SCRIPT, RedisRateLimitStore, type RedisLike } from "./redis-store.js";
import { limitKey, type LimitDescriptor } from "./store.js";

const NOW = 1_700_000_000_000;

const RULES: LimitDescriptor[] = [
  { scope: "register:ip:hour", subject: "203.0.113.9", limit: 5, windowSeconds: 3600 },
  { scope: "register:global:minute", subject: "global", limit: 20, windowSeconds: 60 },
];

function stub(reply: unknown): { store: RedisRateLimitStore; evaluate: RedisLike["eval"] } {
  const evaluate = vi.fn(async () => reply);

  return { store: new RedisRateLimitStore({ eval: evaluate }), evaluate };
}

/**
 * The Lua script is what makes a limit a limit, and it can only really be
 * executed against Redis — which no automated test here may reach. These pin
 * the properties the design turns on; they are not a substitute for running it.
 */
describe("script invariants", () => {
  it("checks every limit before charging any of them", () => {
    const firstCheck = CONSUME_SCRIPT.indexOf("if current >= limit then");
    const firstCharge = CONSUME_SCRIPT.indexOf("INCR");

    // Charging as it goes would penalise a caller for a request that a later
    // descriptor was about to refuse.
    expect(firstCheck).toBeGreaterThan(-1);
    expect(firstCheck).toBeLessThan(firstCharge);
  });

  it("refuses by returning the offending position, not by charging", () => {
    const guard = CONSUME_SCRIPT.slice(
      CONSUME_SCRIPT.indexOf("if current >= limit then"),
      CONSUME_SCRIPT.indexOf("end", CONSUME_SCRIPT.indexOf("if current >= limit then")),
    );

    expect(guard).toContain("return i");
    expect(guard).not.toContain("INCR");
  });

  it("sets the window only when the counter is created", () => {
    // Refreshing on every increment would slide a busy subject's window
    // forward indefinitely, and it would never reset.
    expect(CONSUME_SCRIPT).toContain("if redis.call('INCR', KEYS[i]) == 1 then");
    expect(CONSUME_SCRIPT).toContain("EXPIRE");
    expect(CONSUME_SCRIPT.indexOf("EXPIRE")).toBeGreaterThan(CONSUME_SCRIPT.indexOf("INCR"));
  });

  it("never deletes a counter", () => {
    expect(CONSUME_SCRIPT).not.toContain("DEL");
  });
});

describe("RedisRateLimitStore", () => {
  it("sends one EVAL with keys and (limit, ttl) pairs in order", async () => {
    const { store, evaluate } = stub(0);

    expect(await store.consume(RULES, NOW)).toEqual({ allowed: true, exceeded: null });
    expect(evaluate).toHaveBeenCalledWith(
      CONSUME_SCRIPT,
      RULES.map((rule) => limitKey(rule, NOW)),
      [5, 3600, 20, 60],
    );
  });

  it("reports which descriptor refused", async () => {
    const { store } = stub(2);

    expect(await store.consume(RULES, NOW)).toEqual({
      allowed: false,
      exceeded: RULES[1],
    });
  });

  it("makes no call at all when there is nothing to charge", async () => {
    const { store, evaluate } = stub(0);

    expect(await store.consume([], NOW)).toEqual({ allowed: true, exceeded: null });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it.each([["a string", "yes"], ["null", null], ["out of range", 99]])(
    "throws rather than allowing on %s",
    async (_label, reply) => {
      // An unreadable reply is not evidence that the request was permitted, and
      // the caller's catch turns this into a refusal.
      const { store } = stub(reply);

      await expect(store.consume(RULES, NOW)).rejects.toThrow(/unusable reply/);
    },
  );
});

describe("RedisRateLimitStore.fromEnvironment", () => {
  it("refuses to build without credentials, and names the variables", async () => {
    await expect(RedisRateLimitStore.fromEnvironment({})).rejects.toThrow(/KV_REST_API_URL/);
  });

  it("does not leak the token into the error", async () => {
    const token = "UPSTASH-TOKEN-LEAK-CHECK";

    await expect(
      RedisRateLimitStore.fromEnvironment({ KV_REST_API_TOKEN: token }),
    ).rejects.toThrow(expect.not.stringContaining(token) as unknown as string);
  });
});
