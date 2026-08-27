import { afterAll, describe, expect, it } from "vitest";

import { OPERATOR_DESTINATION_BINDING } from "../../src/anylist/destination.js";
import { RedisIdempotencyStore } from "../../src/idempotency/redis-store.js";
import { DEFAULT_LEASE_MS, type ClaimRequest } from "../../src/idempotency/store.js";
import {
  deleteRecordedTestKeys,
  deleteTestKeyField,
  IsolatedIdempotencyStore,
  TEST_KEY_PREFIX,
} from "./isolated-store.js";
import { requireLiveUpstash } from "./prerequisites.js";

/**
 * LIVE EXTERNAL. `destinationBinding` against real Upstash Redis (M6C-1).
 *
 * The offline suites assert this against the in-process store and against the
 * text of the Lua script. Neither is what runs in production. The property that
 * only real Redis can settle is **immutability by omission**: the binding is
 * written by the fresh-claim branch and by nothing else, so every other branch
 * preserves it purely because it does not name the field. That is a fact about
 * hash-field semantics, not about our code, and asserting it against a `Map`
 * proves nothing.
 *
 * Gated exactly like the conformance suite: `QA_LIVE_EXTERNAL=1` means run or
 * fail, never skip quietly.
 *
 *   QA_LIVE_EXTERNAL=1 npm test -- tests/live/
 *
 * Every key written here lives under `idemtest:v1:<uuid>:`, a prefix no route
 * can produce, and the exact keys created are deleted afterwards. No AnyList
 * module is imported and no AnyList call is made.
 */

const ENABLED = requireLiveUpstash();

const T0 = Date.now();

function claimRequest(over: Partial<ClaimRequest> = {}): ClaimRequest {
  return {
    key: "binding",
    fingerprint: "fp-a",
    requestId: "req-1",
    destinationBinding: OPERATOR_DESTINATION_BINDING,
    now: T0,
    leaseMs: DEFAULT_LEASE_MS,
    ...over,
  };
}

/** A fresh namespace per test, so no case can observe another's record. */
async function isolatedStore(): Promise<IsolatedIdempotencyStore> {
  return new IsolatedIdempotencyStore(await RedisIdempotencyStore.fromEnvironment());
}

describe.skipIf(!ENABLED)("upstash redis — destination binding (LIVE)", () => {
  afterAll(async () => {
    await deleteRecordedTestKeys();
  });

  it("A. persists the binding on a fresh claim", async () => {
    const store = await isolatedStore();

    expect(await store.claim(claimRequest())).toEqual({ status: "claimed" });

    const record = await store.read("binding");
    expect(record?.state).toBe("IN_PROGRESS");
    expect(record?.destinationBinding).toBe("operator:v1");
  });

  it("B. keeps the binding through COMPLETED", async () => {
    const store = await isolatedStore();
    await store.claim(claimRequest());

    await store.complete("binding", "req-1", { id: "recipe-id", name: "Recipe" }, T0 + 10);

    const record = await store.read("binding");
    expect(record?.state).toBe("COMPLETED");
    expect(record?.destinationBinding).toBe("operator:v1");
  });

  it("C. keeps the binding through AMBIGUOUS", async () => {
    const store = await isolatedStore();
    await store.claim(claimRequest());

    await store.fail("binding", "req-1", "AMBIGUOUS", "create_failed", T0 + 10);

    const record = await store.read("binding");
    expect(record?.state).toBe("AMBIGUOUS");
    expect(record?.destinationBinding).toBe("operator:v1");
  });

  it("D. does not let a FAILED_SAFE re-claim overwrite the binding", async () => {
    const store = await isolatedStore();
    await store.claim(claimRequest());
    await store.fail("binding", "req-1", "FAILED_SAFE", "login_failed", T0 + 10);

    // The re-claim presents a *different* binding. The record must keep saying
    // where its first attempt was aimed — this is the property a future
    // account-switch check will rest on, so it is asserted against the real
    // script rather than trusted.
    const reclaim = await store.claim(
      claimRequest({ requestId: "req-2", now: T0 + 20, destinationBinding: "someone-else:v1" }),
    );

    expect(reclaim).toEqual({ status: "claimed" });

    const record = await store.read("binding");
    expect(record?.state).toBe("IN_PROGRESS");
    expect(record?.requestId).toBe("req-2");
    expect(record?.destinationBinding).toBe("operator:v1");
  });

  it("E. reads a record with no binding as null, and leaves its behaviour unchanged", async () => {
    const store = await isolatedStore();
    await store.claim(claimRequest());
    await store.complete("binding", "req-1", { id: "legacy-id", name: "Legacy" }, T0 + 5);

    // Take the field back off, which is what a record written before this
    // field existed actually looks like in Redis.
    await deleteTestKeyField(store.physicalKey("binding"), "destinationBinding");

    const record = await store.read("binding");
    expect(record?.destinationBinding).toBeNull();
    expect(record?.state).toBe("COMPLETED");

    // The absent field neither conflicts, nor forces ambiguity, nor blocks the
    // replay. A legacy record keeps working until its TTL expires.
    expect(await store.claim(claimRequest({ requestId: "req-2", now: T0 + 6 }))).toEqual({
      status: "completed",
      result: { id: "legacy-id", name: "Legacy" },
      originalRequestId: "req-1",
    });

    // And reading it did not quietly upgrade it.
    expect((await store.read("binding"))?.destinationBinding).toBeNull();
  });

  it("writes only isolated test keys", async () => {
    const store = await isolatedStore();

    expect(store.physicalKey("binding").startsWith(TEST_KEY_PREFIX)).toBe(true);
    // The application namespace is a different family entirely.
    expect(store.physicalKey("binding").startsWith("idem:v1:")).toBe(false);
  });
});
