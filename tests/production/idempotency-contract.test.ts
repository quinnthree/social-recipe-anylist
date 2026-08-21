import { describe, expect, it } from "vitest";

import {
  mayCallCreateRecipe,
  PINNED_STATUS,
  REQUIRED_ACTION,
  RETENTION_MS,
  runIdempotencyStoreConformance,
  type ClaimOutcome,
  type IdempotencyRecord,
  type IdempotencyState,
  type IdempotencyStore,
  type StoredResult,
} from "./idempotency-contract.js";

/**
 * Exercises the idempotency conformance suite, and pins the policy table.
 *
 * The store below is a REFERENCE FAKE. It exists only to prove the conformance
 * suite is coherent and runnable before any real store exists. ADR-012 rules an
 * in-process map out explicitly — "lost on restart and inconsistent across
 * instances, which is worse than no idempotency because it presents a false
 * guarantee" — so this must never be promoted into src/. When the Backend agent
 * chooses a durable store, it points runIdempotencyStoreConformance at that
 * instead and this fake stays here as the suite's own self-test.
 */

interface Entry {
  fingerprint: string;
  record: IdempotencyRecord;
  storedAt: number;
}

function createReferenceStore(): IdempotencyStore {
  const entries = new Map<string, Entry>();

  const live = (key: string, now: number): Entry | undefined => {
    const entry = entries.get(key);
    if (entry === undefined) return undefined;
    if (now - entry.storedAt >= RETENTION_MS) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };

  return {
    // Synchronous through the decision and the write, with no await in between,
    // which is what makes the claim atomic. A real store needs the equivalent
    // guarantee from the technology itself, not from JavaScript's event loop.
    async claim(key: string, fingerprint: string, now: number): Promise<ClaimOutcome> {
      const entry = live(key, now);

      if (entry === undefined) {
        entries.set(key, { fingerprint, record: { state: "IN_PROGRESS", result: null }, storedAt: now });
        return { outcome: "claimed" };
      }
      if (entry.fingerprint !== fingerprint) return { outcome: "conflict" };

      return { outcome: "existing", record: entry.record };
    },

    async complete(key: string, result: StoredResult, _now: number): Promise<void> {
      const entry = entries.get(key);
      if (entry === undefined) return;
      entry.record = { state: "COMPLETED", result };
    },

    async fail(key: string, mode: "FAILED_SAFE" | "AMBIGUOUS", _now: number): Promise<void> {
      const entry = entries.get(key);
      if (entry === undefined) return;
      entry.record = { state: mode, result: null };
    },
  };
}

describe("idempotency store conformance (reference fake)", () => {
  runIdempotencyStoreConformance({ createStore: createReferenceStore });
});

describe("the policy table", () => {
  const ALL_STATES: IdempotencyState[] = [
    "NEW",
    "IN_PROGRESS",
    "COMPLETED",
    "FAILED_SAFE",
    "AMBIGUOUS",
  ];

  it("assigns an action to every state", () => {
    for (const state of ALL_STATES) {
      expect(REQUIRED_ACTION[state]).toBeTruthy();
    }
  });

  it("permits an AnyList write in exactly two states", () => {
    // NEW: nothing has happened yet. FAILED_SAFE: we know nothing was written.
    // Nothing else may reach createRecipe, by ADR-012.
    const writable = ALL_STATES.filter((state) => mayCallCreateRecipe(REQUIRED_ACTION[state]));

    expect(writable).toEqual(["NEW", "FAILED_SAFE"]);
  });

  it("never permits a write after an ambiguous outcome", () => {
    // The single most important rule in the whole contract: a write whose
    // outcome we could not determine is never repeated automatically.
    expect(REQUIRED_ACTION.AMBIGUOUS).toBe("REPORT_AMBIGUOUS");
    expect(mayCallCreateRecipe(REQUIRED_ACTION.AMBIGUOUS)).toBe(false);
  });

  it("never permits a write while a request is in progress", () => {
    expect(mayCallCreateRecipe(REQUIRED_ACTION.IN_PROGRESS)).toBe(false);
  });

  it("replays rather than re-writes a completed request", () => {
    expect(REQUIRED_ACTION.COMPLETED).toBe("REPLAY");
    expect(mayCallCreateRecipe("REPLAY")).toBe(false);
  });

  it("distinguishes FAILED_SAFE from AMBIGUOUS, which is the point of both", () => {
    expect(mayCallCreateRecipe(REQUIRED_ACTION.FAILED_SAFE)).toBe(true);
    expect(mayCallCreateRecipe(REQUIRED_ACTION.AMBIGUOUS)).toBe(false);
  });

  it("CONTRACT GAP: two required actions have no status code — QA-011", () => {
    // contracts.md describes IN_PROGRESS as "Return in-progress" and AMBIGUOUS
    // as "Surface for human or client decision", and assigns neither a status
    // code nor an error string. Both are untestable as written, and the iOS
    // client cannot be built against them. Recorded as unresolved rather than
    // invented here.
    expect(PINNED_STATUS.REPORT_IN_PROGRESS).toBeNull();
    expect(PINNED_STATUS.REPORT_AMBIGUOUS).toBeNull();

    expect(PINNED_STATUS.REPLAY).toBe(200);
    expect(PINNED_STATUS.REJECT_CONFLICT).toBe(409);
  });
});

describe("what idempotency does not promise", () => {
  it("is bounded by retention, not unbounded", () => {
    expect(RETENTION_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("cannot be exactly-once against AnyList", () => {
    // ADR-012, stated as a test so it cannot quietly be claimed otherwise: the
    // AnyList API exposes no idempotency key, so a write that landed but whose
    // outcome we never learned is not detectable by protocol. AMBIGUOUS is the
    // name of that hole, not a fix for it.
    expect(REQUIRED_ACTION.AMBIGUOUS).not.toBe("EXECUTE");
    expect(mayCallCreateRecipe(REQUIRED_ACTION.AMBIGUOUS)).toBe(false);
  });
});
