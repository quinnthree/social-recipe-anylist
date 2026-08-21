import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  isValidIdempotencyKey,
  KEY_MAX_LENGTH,
  mayCallCreateRecipe,
  REQUIRED_ACTION,
  REQUIRED_RESPONSE,
  RETENTION_MS,
  runFingerprintConformance,
  runIdempotencyStoreConformance,
  type ClaimOutcome,
  type IdempotencyRecord,
  type IdempotencyState,
  type IdempotencyStore,
  type StoredResult,
} from "./idempotency-contract.js";

/**
 * Exercises the idempotency conformance suites, and pins the policy table.
 *
 * The store below is a REFERENCE FAKE. It exists only to prove the conformance
 * suite is coherent and runnable before the Upstash store is built. ADR-012
 * rules an in-process map out explicitly — "lost on restart and inconsistent
 * across instances, which is worse than no idempotency because it presents a
 * false guarantee" — so this must never be promoted into src/. When the Backend
 * agent wires up Upstash (ADR-017) it points
 * `runIdempotencyStoreConformance` at that instead, and this fake stays here as
 * the suite's own self-test.
 */

const STALE_AFTER_MS = 5 * 60 * 1000;

interface Entry {
  fingerprint: string;
  record: IdempotencyRecord;
  /** When the record was created, for retention. */
  storedAt: number;
  /** When it last changed state, for staleness. */
  touchedAt: number;
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
    // Synchronous through the decision and the write, with no await between,
    // which is what makes the claim atomic here. Upstash must get the
    // equivalent guarantee from the technology — a Lua script or a
    // compare-and-set — not from JavaScript's event loop.
    async claim(key: string, fingerprint: string, now: number): Promise<ClaimOutcome> {
      const entry = live(key, now);

      if (entry === undefined) {
        entries.set(key, {
          fingerprint,
          record: { state: "IN_PROGRESS", result: null },
          storedAt: now,
          touchedAt: now,
        });
        return { outcome: "claimed" };
      }

      // Conflict is decided before state, so a mismatched fingerprint never
      // re-claims a FAILED_SAFE record belonging to a different request.
      if (entry.fingerprint !== fingerprint) return { outcome: "conflict" };

      if (entry.record.state === "FAILED_SAFE") {
        entry.record = { state: "IN_PROGRESS", result: null };
        entry.touchedAt = now;
        return { outcome: "claimed" };
      }

      // Expiry is not evidence of safety: a stale claim becomes AMBIGUOUS
      // rather than becoming available again.
      if (entry.record.state === "IN_PROGRESS" && now - entry.touchedAt >= STALE_AFTER_MS) {
        entry.record = { state: "AMBIGUOUS", result: null };
      }

      return { outcome: "existing", record: entry.record };
    },

    async complete(key: string, result: StoredResult, now: number): Promise<void> {
      const entry = entries.get(key);
      if (entry === undefined) return;
      entry.record = { state: "COMPLETED", result };
      entry.touchedAt = now;
    },

    async fail(key: string, mode: "FAILED_SAFE" | "AMBIGUOUS", now: number): Promise<void> {
      const entry = entries.get(key);
      if (entry === undefined) return;
      entry.record = { state: mode, result: null };
      entry.touchedAt = now;
    },
  };
}

/**
 * Reference fingerprint. Deterministic serialisation is object-key sorting only:
 * arrays keep their order, because ingredient and instruction order carry
 * meaning.
 */
function referenceFingerprint(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(
        Object.keys(input as Record<string, unknown>)
          .sort()
          .map((key) => [key, canonical((input as Record<string, unknown>)[key])]),
      );
    }
    return input;
  };

  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

describe("idempotency store conformance (reference fake)", () => {
  runIdempotencyStoreConformance({
    createStore: createReferenceStore,
    staleAfterMs: STALE_AFTER_MS,
  });
});

describe("fingerprint conformance (reference implementation)", () => {
  runFingerprintConformance(referenceFingerprint);
});

describe("Idempotency-Key validation", () => {
  it("requires a key: it is mandatory on POST /api/exports/anylist", () => {
    expect(isValidIdempotencyKey(undefined)).toBe(false);
  });

  it("rejects an empty key", () => {
    expect(isValidIdempotencyKey("")).toBe(false);
  });

  it("accepts a key from 1 to 128 characters", () => {
    expect(isValidIdempotencyKey("k")).toBe(true);
    expect(isValidIdempotencyKey("x".repeat(KEY_MAX_LENGTH))).toBe(true);
  });

  it("rejects a key over 128 characters", () => {
    // Resolves QA-015: the approved contract pins both the bound and the
    // response, where the earlier draft said "max 255" and said nothing about
    // what happens beyond it.
    expect(isValidIdempotencyKey("x".repeat(KEY_MAX_LENGTH + 1))).toBe(false);
  });
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
    // NEW: nothing has happened yet. FAILED_SAFE: positive evidence that no
    // write occurred. Nothing else may reach createRecipe (ADR-012, ADR-020).
    const writable = ALL_STATES.filter((state) => mayCallCreateRecipe(REQUIRED_ACTION[state]));

    expect(writable).toEqual(["NEW", "FAILED_SAFE"]);
  });

  it("never permits a write after an ambiguous outcome", () => {
    expect(REQUIRED_ACTION.AMBIGUOUS).toBe("REJECT_AMBIGUOUS");
    expect(mayCallCreateRecipe(REQUIRED_ACTION.AMBIGUOUS)).toBe(false);
  });

  it("never permits a write while an export is in progress", () => {
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

  it("pins a status and error string for every rejecting action", () => {
    // Resolves QA-011. Every state now has a defined response, so an iOS client
    // can handle all five.
    expect(REQUIRED_RESPONSE.REJECT_CONFLICT).toEqual({
      status: 409,
      error: "Idempotency key conflict",
    });
    expect(REQUIRED_RESPONSE.REJECT_IN_PROGRESS).toEqual({
      status: 409,
      error: "Export already in progress",
    });
    expect(REQUIRED_RESPONSE.REJECT_AMBIGUOUS).toEqual({
      status: 409,
      error: "Export outcome unknown",
    });
  });

  it("uses 409 for every non-executing, non-replaying state", () => {
    const rejecting = ALL_STATES.map((state) => REQUIRED_ACTION[state]).filter(
      (action) => action !== "EXECUTE" && action !== "REPLAY",
    );

    for (const action of rejecting) {
      expect(REQUIRED_RESPONSE[action].status).toBe(409);
    }
  });
});

describe("what idempotency does not promise", () => {
  it("is bounded by 24-hour retention, not unbounded", () => {
    expect(RETENTION_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("cannot be exactly-once against AnyList", () => {
    // ADR-012, as a test so it cannot quietly be claimed otherwise. AnyList
    // exposes no idempotency key, so a write that landed but whose outcome we
    // never learned is undetectable by protocol. AMBIGUOUS names that hole.
    expect(mayCallCreateRecipe(REQUIRED_ACTION.AMBIGUOUS)).toBe(false);
  });

  it("cannot be cleaned up after the fact either", () => {
    // ADR-021, RESEARCH-PROVEN: deleteRecipe() reports success without
    // deleting, so a duplicate cannot be removed programmatically. That is why
    // three of the four AnyList codes are non-retryable rather than two.
    expect(REQUIRED_ACTION.AMBIGUOUS).not.toBe("EXECUTE");
  });
});
