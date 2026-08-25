import { describe, expect, it } from "vitest";

import { MemoryIdempotencyStore } from "../../src/idempotency/memory-store.js";
import { storeKey } from "../../src/idempotency/store.js";
import {
  forgetTestKeys,
  IsolatedIdempotencyStore,
  recordedTestKeys,
  TEST_KEY_PREFIX,
  uniqueNamespace,
} from "./isolated-store.js";

/**
 * The isolation wrapper, exercised offline against a shared in-process store.
 *
 * Sharing one inner store between two wrappers is the whole point: it
 * reproduces the condition that broke the live run — one database, many
 * conformance tests, all reasoning in `k1` — so a regression to a single
 * static namespace fails here rather than against real Redis.
 */

// Current time, as the conformance suite uses: the in-process store models
// retention against the real clock when `read` is called without one, so a
// fixed past timestamp would read every record as already expired.
const T0 = Date.now();

function claim(store: IsolatedIdempotencyStore, requestId: string, key = "k1") {
  return store.claim({ key, fingerprint: "fp-a", requestId, now: T0, leaseMs: 150_000 });
}

describe("two stores over one database", () => {
  it("cannot see each other's records", async () => {
    const shared = new MemoryIdempotencyStore();
    const first = new IsolatedIdempotencyStore(shared);
    const second = new IsolatedIdempotencyStore(shared);

    expect(await claim(first, "req-original")).toEqual({ status: "claimed" });

    // Without isolation this is the failure M5E-B4 saw: the second store finds
    // `k1` already claimed and reads back the first store's request id.
    expect(await claim(second, "req-1")).toEqual({ status: "claimed" });
    expect((await first.read("k1"))?.requestId).toBe("req-original");
    expect((await second.read("k1"))?.requestId).toBe("req-1");
  });

  it("would collide if the namespace were shared", async () => {
    // Pins the mechanism: same namespace means same physical record, which is
    // precisely what a regression to a static prefix would reintroduce.
    const shared = new MemoryIdempotencyStore();
    const namespace = uniqueNamespace();
    const first = new IsolatedIdempotencyStore(shared, namespace);
    const second = new IsolatedIdempotencyStore(shared, namespace);

    await claim(first, "req-original");

    expect(await claim(second, "req-1")).toEqual({ status: "in_progress" });
  });

  it("gives every instance a different namespace", () => {
    const namespaces = new Set(
      Array.from({ length: 200 }, () => new IsolatedIdempotencyStore(new MemoryIdempotencyStore()))
        .map((store) => store.physicalKey("k1")),
    );

    // Repeat runs and concurrent runs are the same problem as two instances.
    expect(namespaces.size).toBe(200);
  });
});

describe("logical relationships survive the mapping", () => {
  it("keeps one logical key pointing at one record", async () => {
    const store = new IsolatedIdempotencyStore(new MemoryIdempotencyStore());

    await claim(store, "req-1");

    expect(await claim(store, "req-2")).toEqual({ status: "in_progress" });
    expect((await store.read("k1"))?.requestId).toBe("req-1");
  });

  it("keeps distinct logical keys distinct", async () => {
    const store = new IsolatedIdempotencyStore(new MemoryIdempotencyStore());

    expect(await claim(store, "req-1", "k1")).toEqual({ status: "claimed" });
    expect(await claim(store, "req-2", "k2")).toEqual({ status: "claimed" });
    expect(await claim(store, "req-3", "k3")).toEqual({ status: "claimed" });

    expect(new Set(["k1", "k2", "k3"].map((key) => store.physicalKey(key))).size).toBe(3);
  });

  it("maps completion and failure through the same namespace", async () => {
    const shared = new MemoryIdempotencyStore();
    const store = new IsolatedIdempotencyStore(shared);
    const neighbour = new IsolatedIdempotencyStore(shared);

    await claim(store, "req-1");
    await store.complete("k1", "req-1", { id: "a", name: "b" }, T0 + 10);

    expect((await store.read("k1"))?.state).toBe("COMPLETED");
    // The neighbour's `k1` is untouched, so completion did not reach across.
    expect(await neighbour.read("k1")).toBeNull();
  });
});

describe("test keys are recognisably test-owned", () => {
  it("carries a prefix the application can never produce", () => {
    const store = new IsolatedIdempotencyStore(new MemoryIdempotencyStore());
    const physical = store.physicalKey("k1");

    expect(physical.startsWith(TEST_KEY_PREFIX)).toBe(true);
    // Production records live under `idem:v1:`; these cannot collide with one.
    expect(physical.startsWith("idem:v1:")).toBe(false);
  });

  it("leaves the production key format untouched", () => {
    // The seam is test-only: no runtime caller changed, and a real record is
    // still addressed exactly as before.
    expect(storeKey("/api/exports/anylist", "client-key")).toMatch(
      /^idem:v1:\/api\/exports\/anylist:[0-9a-f]{64}$/,
    );
    expect(storeKey("/api/exports/anylist", "client-key")).not.toContain(TEST_KEY_PREFIX);
  });

  it("records every physical key it touched, for exact-match cleanup", () => {
    forgetTestKeys();
    const store = new IsolatedIdempotencyStore(new MemoryIdempotencyStore());

    store.physicalKey("k1");
    store.physicalKey("k2");

    const recorded = recordedTestKeys();
    expect(recorded).toHaveLength(2);
    expect(recorded.every((key) => key.startsWith(TEST_KEY_PREFIX))).toBe(true);

    forgetTestKeys();
    expect(recordedTestKeys()).toHaveLength(0);
  });
});
