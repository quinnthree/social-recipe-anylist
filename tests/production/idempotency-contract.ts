import { expect, it, describe } from "vitest";

/**
 * An executable form of the idempotency semantics frozen in contracts.md
 * ("Idempotency-Key → Frozen semantics") and ADR-012.
 *
 * This file chooses no storage technology and implements no endpoint. It
 * defines the smallest port the frozen semantics can be expressed against, and
 * a conformance suite any candidate store must pass. When the Backend agent
 * picks a durable store, it calls `runIdempotencyStoreConformance` with a
 * factory for it and the semantics are checked without the suite knowing
 * anything about the technology.
 *
 * The port's *names* are a test seam, not a contract. The Backend agent may
 * call these methods whatever it likes and adapt. The behaviour is the part
 * that is frozen.
 *
 * REQUIRES OVERSIGHT SIGN-OFF before it is treated as binding on the backend.
 */

export const RETENTION_MS = 24 * 60 * 60 * 1000;

/** The conceptual states, verbatim from contracts.md. */
export type IdempotencyState =
  | "NEW"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "FAILED_SAFE"
  | "AMBIGUOUS";

/** The response replayed for a COMPLETED key. Opaque to the store. */
export interface StoredResult {
  status: number;
  body: unknown;
}

export interface IdempotencyRecord {
  state: Exclude<IdempotencyState, "NEW">;
  /** Present only when state is COMPLETED. */
  result: StoredResult | null;
}

export type ClaimOutcome =
  /** The key was unseen (or expired). The caller now holds it, IN_PROGRESS. */
  | { outcome: "claimed" }
  /** The key is held for this same request. The caller must not execute. */
  | { outcome: "existing"; record: IdempotencyRecord }
  /** The key is held for a different request body. 409. */
  | { outcome: "conflict" };

/**
 * The minimal port. `now` is passed in rather than read, so retention is
 * testable without waiting 24 hours or faking a global clock.
 */
export interface IdempotencyStore {
  claim(key: string, fingerprint: string, now: number): Promise<ClaimOutcome>;
  complete(key: string, result: StoredResult, now: number): Promise<void>;
  fail(key: string, mode: "FAILED_SAFE" | "AMBIGUOUS", now: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// The policy table: what the endpoint must do for each state it finds.
// ---------------------------------------------------------------------------

export type ExportAction =
  /** Call createRecipe. The only action permitted to write to AnyList. */
  | "EXECUTE"
  /** Return the stored response with idempotent: true. No write. */
  | "REPLAY"
  /** 409 Idempotency key conflict. No write. */
  | "REJECT_CONFLICT"
  /** Report that the original request is still running. No write. */
  | "REPORT_IN_PROGRESS"
  /** Surface for human or client decision. No write, ever, automatically. */
  | "REPORT_AMBIGUOUS";

export const REQUIRED_ACTION: Record<IdempotencyState, ExportAction> = {
  NEW: "EXECUTE",
  // "A request already marked in progress must not execute createRecipe again."
  IN_PROGRESS: "REPORT_IN_PROGRESS",
  // "replay the original completed response. No second AnyList write."
  COMPLETED: "REPLAY",
  // "Failed with confidence that no AnyList write occurred... Safe to retry."
  FAILED_SAFE: "EXECUTE",
  // "Never auto-retry. Surface for human or client decision."
  AMBIGUOUS: "REPORT_AMBIGUOUS",
};

/** The single rule ADR-012 exists to enforce. */
export function mayCallCreateRecipe(action: ExportAction): boolean {
  return action === "EXECUTE";
}

/**
 * Statuses contracts.md actually pins. `null` marks a case the contract
 * describes in prose but never assigns a status or error string to — an
 * unresolved contract question, recorded here rather than invented.
 * See docs/qa/production-api-test-plan.md.
 */
export const PINNED_STATUS: Record<ExportAction, number | null> = {
  EXECUTE: 200,
  REPLAY: 200,
  REJECT_CONFLICT: 409,
  REPORT_IN_PROGRESS: null,
  REPORT_AMBIGUOUS: null,
};

// ---------------------------------------------------------------------------
// The conformance suite.
// ---------------------------------------------------------------------------

export interface ConformanceOptions {
  /** A fresh, empty store for each test. */
  createStore: () => IdempotencyStore | Promise<IdempotencyStore>;
  /**
   * Set false for a store that cannot make `claim` atomic across concurrent
   * callers. Doing so is a declaration that it does not satisfy "at most one
   * may execute the export", not a way to skip the test quietly.
   */
  supportsConcurrentClaim?: boolean;
}

const T0 = 1_700_000_000_000;
const RESULT: StoredResult = { status: 200, body: { success: true, saved: { id: "anylist-1" } } };

/**
 * Runs the frozen semantics against a candidate store. Call from a .test.ts:
 *
 *   describe("redis store", () => runIdempotencyStoreConformance({ createStore }));
 */
export function runIdempotencyStoreConformance({
  createStore,
  supportsConcurrentClaim = true,
}: ConformanceOptions): void {
  describe("claiming a key", () => {
    it("claims an unseen key", async () => {
      const store = await createStore();

      expect(await store.claim("k1", "body-a", T0)).toEqual({ outcome: "claimed" });
    });

    it("keeps separate keys independent", async () => {
      const store = await createStore();
      await store.claim("k1", "body-a", T0);

      expect(await store.claim("k2", "body-b", T0)).toEqual({ outcome: "claimed" });
    });

    it("accepts a key at the 255-character maximum", async () => {
      const store = await createStore();

      expect(await store.claim("x".repeat(255), "body-a", T0)).toEqual({ outcome: "claimed" });
    });
  });

  describe("same key, same body", () => {
    it("reports IN_PROGRESS while the first request is still running", async () => {
      const store = await createStore();
      await store.claim("k1", "body-a", T0);

      expect(await store.claim("k1", "body-a", T0 + 10)).toEqual({
        outcome: "existing",
        record: { state: "IN_PROGRESS", result: null },
      });
    });

    it("replays the original response once completed", async () => {
      const store = await createStore();
      await store.claim("k1", "body-a", T0);
      await store.complete("k1", RESULT, T0 + 100);

      expect(await store.claim("k1", "body-a", T0 + 200)).toEqual({
        outcome: "existing",
        record: { state: "COMPLETED", result: RESULT },
      });
    });

    it.each(["FAILED_SAFE", "AMBIGUOUS"] as const)("reports a %s outcome as itself", async (mode) => {
      const store = await createStore();
      await store.claim("k1", "body-a", T0);
      await store.fail("k1", mode, T0 + 100);

      expect(await store.claim("k1", "body-a", T0 + 200)).toEqual({
        outcome: "existing",
        record: { state: mode, result: null },
      });
    });

    it("never downgrades a COMPLETED record to a retryable one", async () => {
      const store = await createStore();
      await store.claim("k1", "body-a", T0);
      await store.complete("k1", RESULT, T0 + 100);

      const claim = await store.claim("k1", "body-a", T0 + 200);

      expect(claim.outcome).toBe("existing");
      expect(claim.outcome === "existing" && claim.record.state).toBe("COMPLETED");
    });
  });

  describe("same key, different body", () => {
    it.each([
      ["in progress", null],
      ["completed", "complete"],
      ["failed safe", "FAILED_SAFE"],
      ["ambiguous", "AMBIGUOUS"],
    ] as const)("conflicts when the original is %s", async (_label, finish) => {
      const store = await createStore();
      await store.claim("k1", "body-a", T0);
      if (finish === "complete") await store.complete("k1", RESULT, T0 + 10);
      else if (finish !== null) await store.fail("k1", finish, T0 + 10);

      expect(await store.claim("k1", "body-b", T0 + 20)).toEqual({ outcome: "conflict" });
    });

    it("conflicts on the body, not on the key alone", async () => {
      const store = await createStore();
      await store.claim("k1", "body-a", T0);

      expect(await store.claim("k1", "body-a", T0 + 5)).not.toEqual({ outcome: "conflict" });
      expect(await store.claim("k1", "body-b", T0 + 5)).toEqual({ outcome: "conflict" });
    });
  });

  describe("concurrency", () => {
    it.runIf(supportsConcurrentClaim)(
      "lets exactly one of many concurrent claims win",
      async () => {
        // "Concurrent requests with the same key: at most one may execute the
        // export." Everything downstream of idempotency rests on this being
        // atomic in the store, not in application code.
        const store = await createStore();

        const claims = await Promise.all(
          Array.from({ length: 20 }, () => store.claim("k1", "body-a", T0)),
        );
        const winners = claims.filter((claim) => claim.outcome === "claimed");

        expect(winners).toHaveLength(1);
        expect(claims.filter((c) => c.outcome === "existing")).toHaveLength(19);
      },
    );

    it.runIf(supportsConcurrentClaim)("serialises concurrent claims for different keys independently", async () => {
      const store = await createStore();

      const claims = await Promise.all([
        store.claim("k1", "body-a", T0),
        store.claim("k2", "body-a", T0),
        store.claim("k3", "body-a", T0),
      ]);

      expect(claims.every((claim) => claim.outcome === "claimed")).toBe(true);
    });
  });

  describe("retention", () => {
    it("still replays a completed record just under 24 hours old", async () => {
      const store = await createStore();
      await store.claim("k1", "body-a", T0);
      await store.complete("k1", RESULT, T0);

      const claim = await store.claim("k1", "body-a", T0 + RETENTION_MS - 1000);

      expect(claim.outcome).toBe("existing");
    });

    it("treats a record older than 24 hours as gone", async () => {
      // The direct consequence of "Retention: 24 hours", and worth stating
      // plainly: after the window, the same key with the same body is claimable
      // again and a retry WILL write to AnyList a second time. Retention is a
      // bound on the guarantee, not a footnote to it.
      const store = await createStore();
      await store.claim("k1", "body-a", T0);
      await store.complete("k1", RESULT, T0);

      expect(await store.claim("k1", "body-a", T0 + RETENTION_MS + 1000)).toEqual({
        outcome: "claimed",
      });
    });

    it("does not conflict against an expired record", async () => {
      const store = await createStore();
      await store.claim("k1", "body-a", T0);
      await store.complete("k1", RESULT, T0);

      expect(await store.claim("k1", "body-b", T0 + RETENTION_MS + 1000)).toEqual({
        outcome: "claimed",
      });
    });
  });
}
