import { describe, expect, it } from "vitest";

import { OPERATOR_DESTINATION_BINDING } from "../../src/anylist/destination.js";
import { MemoryIdempotencyStore } from "../../src/idempotency/memory-store.js";
import { CLAIM_SCRIPT } from "../../src/idempotency/redis-store.js";
import { DEFAULT_LEASE_MS, type ClaimRequest } from "../../src/idempotency/store.js";

/**
 * Destination binding on idempotency records (M6C-1).
 *
 * An idempotency key answers "has this logical operation already run?", which is
 * only a safe question if the *destination* is the same too — and a key alone
 * can never say so. Today there is one destination, so nothing is enforced; the
 * record simply states where its write was aimed, immutably, so that when
 * consumer accounts arrive the field is already present on records rather than
 * being retrofitted onto ones that never carried it.
 *
 * Nothing here contacts AnyList or resolves a real account. `operator:v1` is an
 * opaque label, not an identifier.
 */

const KEY = "idem:v1:exports-anylist:abc";
const T0 = 1_700_000_000_000;

/**
 * A claim as a deployment before this field would have made it.
 *
 * The cast is deliberate and confined here: the type requires a binding, but
 * records written before the field existed genuinely have none, and the point
 * of these tests is that such a record still behaves exactly as it always did.
 */
function legacyClaimRequest(over: Partial<ClaimRequest> = {}): ClaimRequest {
  return { ...claimRequest(over), destinationBinding: null as unknown as string };
}

function claimRequest(over: Partial<ClaimRequest> = {}): ClaimRequest {
  return {
    key: KEY,
    fingerprint: "fp-a",
    requestId: "req-1",
    destinationBinding: OPERATOR_DESTINATION_BINDING,
    now: T0,
    leaseMs: DEFAULT_LEASE_MS,
    ...over,
  };
}

describe("a new claim records where the export was aimed", () => {
  it("persists the operator binding", async () => {
    const store = new MemoryIdempotencyStore();

    await store.claim(claimRequest());

    expect((await store.read(KEY, T0))?.destinationBinding).toBe("operator:v1");
  });

  it("uses an opaque label, not a discovered AnyList identity", () => {
    // No login, no userId, no configuration is required to produce it. If this
    // ever becomes something resolved from AnyList, that is a new milestone.
    expect(OPERATOR_DESTINATION_BINDING).toBe("operator:v1");
  });
});

describe("the binding is immutable for the life of the record", () => {
  it("survives completion", async () => {
    const store = new MemoryIdempotencyStore();
    await store.claim(claimRequest());

    await store.complete(KEY, "req-1", { id: "recipe-id", name: "Recipe" }, T0 + 10);

    const record = await store.read(KEY, T0 + 10);
    expect(record?.state).toBe("COMPLETED");
    expect(record?.destinationBinding).toBe("operator:v1");
  });

  it("survives an ambiguous failure", async () => {
    const store = new MemoryIdempotencyStore();
    await store.claim(claimRequest());

    await store.fail(KEY, "req-1", "AMBIGUOUS", "create_failed", T0 + 10);

    const record = await store.read(KEY, T0 + 10);
    expect(record?.state).toBe("AMBIGUOUS");
    expect(record?.destinationBinding).toBe("operator:v1");
  });

  it("survives the stale-lease conversion to AMBIGUOUS", async () => {
    const store = new MemoryIdempotencyStore();
    await store.claim(claimRequest());

    const later = T0 + DEFAULT_LEASE_MS + 1;
    expect(await store.claim(claimRequest({ requestId: "req-2", now: later }))).toEqual({
      status: "ambiguous",
    });

    expect((await store.read(KEY, later))?.destinationBinding).toBe("operator:v1");
  });

  it("is not replaced when a FAILED_SAFE record is re-claimed", async () => {
    const store = new MemoryIdempotencyStore();
    await store.claim(claimRequest());
    await store.fail(KEY, "req-1", "FAILED_SAFE", "login_failed", T0 + 10);

    // A re-claim continues an existing record. Even a caller presenting a
    // different binding must not be able to rewrite what the record says its
    // first attempt targeted — that is the property the future account-switch
    // check will rest on.
    const reclaim = await store.claim(
      claimRequest({ requestId: "req-2", now: T0 + 20, destinationBinding: "someone-else:v1" }),
    );

    expect(reclaim).toEqual({ status: "claimed" });
    expect((await store.read(KEY, T0 + 20))?.destinationBinding).toBe("operator:v1");
  });
});

describe("the Redis script writes the binding on a fresh claim only", () => {
  it("records it in the fresh-claim branch", () => {
    expect(CLAIM_SCRIPT).toContain("'destinationBinding', destinationBinding");
  });

  it("names it exactly once, so no other branch can rewrite it", () => {
    // Immutability in the script is a property of what it does *not* write.
    // Adding the field to another HSET would break it silently, so the count is
    // asserted rather than the absence being assumed.
    const writes = CLAIM_SCRIPT.match(/'destinationBinding', destinationBinding/g) ?? [];

    expect(writes).toHaveLength(1);
  });

  it("reads it from the last argument, appended rather than inserted", () => {
    // The script reads ARGV positionally; inserting would shift every existing
    // branch's arguments.
    expect(CLAIM_SCRIPT).toContain("local destinationBinding = ARGV[7]");
  });
});

describe("records created before this field behave exactly as before", () => {
  it("is readable, matchable, and replayable with no binding at all", async () => {
    const store = new MemoryIdempotencyStore();

    // A record as an older deployment wrote it: no destinationBinding.
    await store.claim(legacyClaimRequest());
    await store.complete(KEY, "req-1", { id: "legacy-id", name: "Legacy" }, T0 + 5);

    const record = await store.read(KEY, T0 + 5);
    expect(record?.destinationBinding).toBeNull();

    // The absent field neither conflicts, nor forces ambiguity, nor blocks the
    // replay. A legacy record simply keeps working until its TTL expires.
    expect(await store.claim(claimRequest({ requestId: "req-2", now: T0 + 6 }))).toEqual({
      status: "completed",
      result: { id: "legacy-id", name: "Legacy" },
      originalRequestId: "req-1",
    });
  });

  it("is not migrated, rewritten, or moved to a new namespace", async () => {
    const store = new MemoryIdempotencyStore();
    await store.claim(legacyClaimRequest());

    await store.claim(claimRequest({ requestId: "req-2", now: T0 + 1 }));

    // Still the same key, still no binding: reading a legacy record does not
    // quietly upgrade it.
    expect((await store.read(KEY, T0 + 1))?.destinationBinding).toBeNull();
    expect(KEY.startsWith("idem:v1:")).toBe(true);
  });
});
