import { describe, expect, it, vi } from "vitest";

import { CLAIM_SCRIPT, RedisIdempotencyStore, SETTLE_SCRIPT, type RedisLike } from "./redis-store.js";
import { RETENTION_SECONDS } from "./store.js";

const KEY = "idem:v1:exports-anylist:abc";
const CLAIM = {
  key: KEY,
  fingerprint: "print-a",
  requestId: "req_1",
  now: 1_700_000_000_000,
  leaseMs: 150_000,
};

function stub(reply: unknown): { store: RedisIdempotencyStore; evaluate: RedisLike["eval"] } {
  const evaluate = vi.fn(async () => reply);
  const hgetall = vi.fn(async () => null);

  return { store: new RedisIdempotencyStore({ eval: evaluate, hgetall }), evaluate };
}

/**
 * The Lua script is what makes the claim atomic, and it can only really be
 * executed against Redis — which no automated test here is allowed to reach.
 *
 * These assertions pin the specific properties the whole design turns on, so a
 * future edit that quietly breaks one fails here rather than in production.
 * They are not a substitute for running the script: that is a live-verification
 * step, and it is recorded as one.
 */
describe("CLAIM_SCRIPT invariants", () => {
  it("checks the fingerprint before branching on state", () => {
    const fingerprintCheck = CLAIM_SCRIPT.indexOf("'fingerprint') ~= fingerprint");
    const firstStateBranch = CLAIM_SCRIPT.indexOf("if state == 'COMPLETED'");

    expect(fingerprintCheck).toBeGreaterThan(-1);
    expect(fingerprintCheck).toBeLessThan(firstStateBranch);
  });

  it("treats the FAILED_SAFE branch as a claim, taking a fresh lease", () => {
    const branch = CLAIM_SCRIPT.slice(
      CLAIM_SCRIPT.indexOf("if state == 'FAILED_SAFE'"),
      CLAIM_SCRIPT.indexOf("local lease ="),
    );

    // Leaving this outside the atomic step would let two concurrent retries of
    // a safely-failed export both proceed.
    expect(branch).toContain("'state', 'IN_PROGRESS'");
    expect(branch).toContain("leaseExpiresAt");
    expect(branch).toContain("return {'claimed'}");
  });

  it("never deletes a record", () => {
    // Expiry is not evidence of safety: a stale claim is converted, not removed.
    // (`HDEL` on a single field is fine — it is the key itself that must survive.)
    expect(CLAIM_SCRIPT).not.toContain("'DEL'");
    expect(CLAIM_SCRIPT).not.toContain("'UNLINK'");
  });

  it("converts a stale lease to AMBIGUOUS rather than claiming it", () => {
    const tail = CLAIM_SCRIPT.slice(CLAIM_SCRIPT.indexOf("local lease ="));

    expect(tail).toContain("'state', 'AMBIGUOUS'");
    expect(tail).toContain("lease_expired");
    expect(tail).not.toContain("claimed");
  });

  it("guards both settle transitions on still holding the claim", () => {
    expect(SETTLE_SCRIPT).toContain("~= 'IN_PROGRESS' then return 0");
    expect(SETTLE_SCRIPT).toContain("'requestId') ~= requestId then return 0");
  });
});

describe("RedisIdempotencyStore", () => {
  it("sends one EVAL with the documented argument order", async () => {
    const { store, evaluate } = stub(["claimed"]);

    await store.claim(CLAIM);

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledWith(
      CLAIM_SCRIPT,
      [KEY],
      [
        "print-a",
        "req_1",
        CLAIM.now,
        CLAIM.leaseMs,
        RETENTION_SECONDS.IN_PROGRESS,
        RETENTION_SECONDS.AMBIGUOUS,
      ],
    );
  });

  it.each([
    ["claimed", { status: "claimed" }],
    ["conflict", { status: "conflict" }],
    ["in_progress", { status: "in_progress" }],
    ["ambiguous", { status: "ambiguous" }],
  ])("decodes a %s reply", async (reply, expected) => {
    const { store } = stub([reply]);

    expect(await store.claim(CLAIM)).toEqual(expected);
  });

  it("decodes a completed reply whose result arrived as a string", async () => {
    const { store } = stub(["completed", JSON.stringify({ id: "r1", name: "Brownies" }), "req_0"]);

    expect(await store.claim(CLAIM)).toEqual({
      status: "completed",
      result: { id: "r1", name: "Brownies" },
      originalRequestId: "req_0",
    });
  });

  it("decodes a completed reply whose result Upstash already parsed", async () => {
    // The client deserialises JSON-looking values automatically, so the same
    // field can arrive either way depending on version and configuration.
    const { store } = stub(["completed", { id: "r1", name: "Brownies" }, "req_0"]);

    expect(await store.claim(CLAIM)).toEqual({
      status: "completed",
      result: { id: "r1", name: "Brownies" },
      originalRequestId: "req_0",
    });
  });

  it("reads a COMPLETED record with an unusable result as ambiguous, not as success", async () => {
    const { store } = stub(["completed", "not-json", "req_0"]);

    expect(await store.claim(CLAIM)).toEqual({ status: "ambiguous" });
  });

  it("treats an unrecognised reply as ambiguous rather than assuming a claim", async () => {
    const { store } = stub(["something-new"]);

    expect(await store.claim(CLAIM)).toEqual({ status: "ambiguous" });
  });

  it("uses the 24-hour window when completing and 30 days when marking ambiguous", async () => {
    const { store, evaluate } = stub(1);

    await store.complete(KEY, "req_1", { id: "r1", name: "Brownies" }, CLAIM.now);
    await store.fail(KEY, "req_1", "AMBIGUOUS", "create_failed", CLAIM.now);
    await store.fail(KEY, "req_1", "FAILED_SAFE", "login_failed", CLAIM.now);

    const ttlOf = (call: number): unknown =>
      (vi.mocked(evaluate).mock.calls[call]?.[2] as unknown[])[4];

    expect(ttlOf(0)).toBe(RETENTION_SECONDS.COMPLETED);
    expect(ttlOf(1)).toBe(RETENTION_SECONDS.AMBIGUOUS);
    expect(ttlOf(2)).toBe(RETENTION_SECONDS.FAILED_SAFE);
    expect(RETENTION_SECONDS.AMBIGUOUS).toBe(30 * 24 * 60 * 60);
  });

  it("reads a stored record back", async () => {
    const store = new RedisIdempotencyStore({
      eval: async () => 1,
      hgetall: async () => ({
        state: "AMBIGUOUS",
        fingerprint: "print-a",
        requestId: "req_1",
        leaseExpiresAt: "1700000150000",
        failureCode: "create_failed",
        createdAt: "1700000000000",
        updatedAt: "1700000010000",
      }),
    });

    expect(await store.read(KEY)).toEqual({
      state: "AMBIGUOUS",
      fingerprint: "print-a",
      requestId: "req_1",
      leaseExpiresAt: 1_700_000_150_000,
      result: null,
      failureCode: "create_failed",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_010_000,
    });
  });

  it("reads a missing key as absent", async () => {
    const store = new RedisIdempotencyStore({ eval: async () => 1, hgetall: async () => null });

    expect(await store.read(KEY)).toBeNull();
  });
});

describe("RedisIdempotencyStore.fromEnvironment", () => {
  it("refuses to build without credentials, and names the variables", async () => {
    await expect(RedisIdempotencyStore.fromEnvironment({})).rejects.toThrow(
      "Upstash Redis is not configured",
    );
  });

  it("does not leak the token into the error", async () => {
    const error = await RedisIdempotencyStore.fromEnvironment({
      KV_REST_API_URL: "https://example.upstash.io",
    }).catch((thrown: unknown) => thrown);

    expect(String(error)).not.toContain("example.upstash.io");
  });
});
