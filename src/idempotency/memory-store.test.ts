import { describe, expect, it } from "vitest";

import { MemoryIdempotencyStore } from "./memory-store.js";
import { RETENTION_SECONDS, type ClaimRequest, type IdempotencyStore } from "./store.js";

const KEY = "idem:v1:exports-anylist:abc";
const PRINT = "fingerprint-a";
const OTHER_PRINT = "fingerprint-b";
const LEASE_MS = 150_000;
const T0 = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function claimAt(
  store: IdempotencyStore,
  now: number,
  overrides: Partial<ClaimRequest> = {},
): ReturnType<IdempotencyStore["claim"]> {
  return store.claim({
    key: KEY,
    fingerprint: PRINT,
    requestId: "req_1", destinationBinding: "operator:v1",
    now,
    leaseMs: LEASE_MS,
    ...overrides,
  });
}

describe("MemoryIdempotencyStore", () => {
  describe("claiming", () => {
    it("claims an unseen key", async () => {
      const store = new MemoryIdempotencyStore();

      expect(await claimAt(store, T0)).toEqual({ status: "claimed" });
    });

    it("reports in_progress while the lease is live", async () => {
      const store = new MemoryIdempotencyStore();
      await claimAt(store, T0);

      const second = await claimAt(store, T0 + 1_000, { requestId: "req_2" });

      expect(second).toEqual({ status: "in_progress" });
    });

    it("rejects a different request under the same key", async () => {
      const store = new MemoryIdempotencyStore();
      await claimAt(store, T0);

      expect(await claimAt(store, T0 + 1, { fingerprint: OTHER_PRINT })).toEqual({
        status: "conflict",
      });
    });

    it("checks the fingerprint before the state, so a mismatched retry never claims", async () => {
      const store = new MemoryIdempotencyStore();
      await claimAt(store, T0);
      await store.fail(KEY, "req_1", "FAILED_SAFE", "login_failed", T0 + 10);

      // FAILED_SAFE is retryable — but not by a different request.
      expect(await claimAt(store, T0 + 20, { fingerprint: OTHER_PRINT })).toEqual({
        status: "conflict",
      });
    });
  });

  describe("FAILED_SAFE re-claim", () => {
    it("is itself an atomic claim, not merely a permission to proceed", async () => {
      const store = new MemoryIdempotencyStore();
      await claimAt(store, T0);
      await store.fail(KEY, "req_1", "FAILED_SAFE", "login_failed", T0 + 10);

      expect(await claimAt(store, T0 + 20, { requestId: "req_2" })).toEqual({ status: "claimed" });

      // The re-claim took the lease: a third concurrent retry must not proceed.
      expect(await claimAt(store, T0 + 21, { requestId: "req_3" })).toEqual({
        status: "in_progress",
      });
    });

    it("clears the previous failure code", async () => {
      const store = new MemoryIdempotencyStore();
      await claimAt(store, T0);
      await store.fail(KEY, "req_1", "FAILED_SAFE", "login_failed", T0 + 10);
      await claimAt(store, T0 + 20, { requestId: "req_2" });

      const record = await store.read(KEY, T0 + 21);

      expect(record?.state).toBe("IN_PROGRESS");
      expect(record?.failureCode).toBeNull();
      // The original creation time survives the re-claim.
      expect(record?.createdAt).toBe(T0);
    });
  });

  describe("replay", () => {
    it("returns the recorded result and the original request id", async () => {
      const store = new MemoryIdempotencyStore();
      await claimAt(store, T0);
      await store.complete(KEY, "req_1", { id: "recipe-1", name: "Brownies" }, T0 + 500);

      expect(await claimAt(store, T0 + 600, { requestId: "req_2" })).toEqual({
        status: "completed",
        result: { id: "recipe-1", name: "Brownies" },
        originalRequestId: "req_1",
      });
    });
  });

  describe("stale lease", () => {
    it("becomes AMBIGUOUS, never claimable — expiry is not evidence of safety", async () => {
      const store = new MemoryIdempotencyStore();
      await claimAt(store, T0);

      const stale = await claimAt(store, T0 + LEASE_MS + 1, { requestId: "req_2" });

      expect(stale).toEqual({ status: "ambiguous" });
    });

    it("converts the record before any new claim can be made", async () => {
      const store = new MemoryIdempotencyStore();
      await claimAt(store, T0);
      await claimAt(store, T0 + LEASE_MS + 1, { requestId: "req_2" });

      const record = await store.read(KEY, T0 + LEASE_MS + 2);

      expect(record?.state).toBe("AMBIGUOUS");
      expect(record?.failureCode).toBe("lease_expired");
    });

    it("stays ambiguous for every later attempt", async () => {
      const store = new MemoryIdempotencyStore();
      await claimAt(store, T0);
      await claimAt(store, T0 + LEASE_MS + 1, { requestId: "req_2" });

      expect(await claimAt(store, T0 + 29 * DAY, { requestId: "req_3" })).toEqual({
        status: "ambiguous",
      });
    });
  });

  describe("state-dependent retention (ADR-025)", () => {
    it("keeps a COMPLETED record for the 24-hour replay window", async () => {
      const store = new MemoryIdempotencyStore();
      await claimAt(store, T0);
      await store.complete(KEY, "req_1", { id: "recipe-1", name: "Brownies" }, T0);

      expect((await store.read(KEY, T0 + 23 * HOUR))?.state).toBe("COMPLETED");
      expect(await store.read(KEY, T0 + RETENTION_SECONDS.COMPLETED * 1000)).toBeNull();
    });

    it("keeps a FAILED_SAFE record for 24 hours", async () => {
      const store = new MemoryIdempotencyStore();
      await claimAt(store, T0);
      await store.fail(KEY, "req_1", "FAILED_SAFE", "login_failed", T0);

      expect((await store.read(KEY, T0 + 23 * HOUR))?.state).toBe("FAILED_SAFE");
      expect(await store.read(KEY, T0 + RETENTION_SECONDS.FAILED_SAFE * 1000)).toBeNull();
    });

    it("holds an AMBIGUOUS record for 30 days, not 24 hours", async () => {
      const store = new MemoryIdempotencyStore();
      await claimAt(store, T0);
      await store.fail(KEY, "req_1", "AMBIGUOUS", "create_failed", T0);

      // A flat 24-hour TTL would let the key read as unseen and permit a second
      // AnyList write solely because time passed. That is the bug ADR-025 fixes.
      expect((await store.read(KEY, T0 + 25 * HOUR))?.state).toBe("AMBIGUOUS");
      expect(await claimAt(store, T0 + 29 * DAY, { requestId: "req_2" })).toEqual({
        status: "ambiguous",
      });
    });

    it("holds an IN_PROGRESS record far beyond its lease", async () => {
      const store = new MemoryIdempotencyStore();
      await claimAt(store, T0);

      // Record TTL and execution lease are different things: the lease is long
      // dead, the record is not.
      expect((await store.read(KEY, T0 + 25 * HOUR))?.state).toBe("IN_PROGRESS");
    });

    it("stops claiming duplicate protection after the ambiguity window", async () => {
      const store = new MemoryIdempotencyStore();
      await claimAt(store, T0);
      await store.fail(KEY, "req_1", "AMBIGUOUS", "create_failed", T0);

      // Honest limit: 30 days bounds how long we hold uncertainty. It is not a
      // proof, and the contract says so.
      expect(await claimAt(store, T0 + 31 * DAY, { requestId: "req_2" })).toEqual({
        status: "claimed",
      });
    });
  });

  describe("transition ownership", () => {
    it("ignores a completion from a request that no longer holds the claim", async () => {
      const store = new MemoryIdempotencyStore();
      await claimAt(store, T0);
      await claimAt(store, T0 + LEASE_MS + 1, { requestId: "req_2" }); // -> AMBIGUOUS

      // req_1 finishes late. It must not overwrite preserved uncertainty with a
      // confident answer nobody is waiting for.
      await store.complete(KEY, "req_1", { id: "recipe-1", name: "Brownies" }, T0 + LEASE_MS + 2);

      expect((await store.read(KEY, T0 + LEASE_MS + 3))?.state).toBe("AMBIGUOUS");
    });

    it("ignores a failure written by a different request", async () => {
      const store = new MemoryIdempotencyStore();
      await claimAt(store, T0);
      await store.fail(KEY, "req_other", "AMBIGUOUS", "create_failed", T0 + 5);

      expect((await store.read(KEY, T0 + 6))?.state).toBe("IN_PROGRESS");
    });
  });
});
