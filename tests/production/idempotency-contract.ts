import { describe, expect, it } from "vitest";

/**
 * An executable form of the APPROVED idempotency contract:
 * `contracts.md` "Idempotency-Key — PROPOSED", "Request fingerprint", ADR-012
 * (amended), ADR-017, ADR-018.
 *
 * This file chooses no storage technology and implements no endpoint. ADR-017
 * selects Upstash Redis behind an `IdempotencyStore` abstraction; this suite is
 * written against the smallest port those semantics need, so the Backend agent
 * can point it at the real store:
 *
 *   describe("upstash store", () => runIdempotencyStoreConformance({ createStore }));
 *
 * The port's *names* are a test seam, not a contract. The behaviour is the
 * frozen part.
 */

/** ADR-017. */
export const RETENTION_MS = 24 * 60 * 60 * 1000;

/** contracts.md: "Length 1–128 characters." */
export const KEY_MIN_LENGTH = 1;
export const KEY_MAX_LENGTH = 128;

/** Approved states. */
export type IdempotencyState =
  | "NEW"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "FAILED_SAFE"
  | "AMBIGUOUS";

/** The recorded result replayed for a COMPLETED key. Opaque to the store. */
export interface StoredResult {
  status: number;
  body: unknown;
  /**
   * The request that performed the original AnyList write. Surfaces as
   * `originalRequestId` on a replay.
   */
  requestId: string;
}

export interface IdempotencyRecord {
  state: Exclude<IdempotencyState, "NEW">;
  /** Present only when state is COMPLETED. */
  result: StoredResult | null;
}

export type ClaimOutcome =
  /** Unseen, or a FAILED_SAFE re-claim. The caller now holds it, IN_PROGRESS. */
  | { outcome: "claimed" }
  /** Held. The caller must not execute; `record.state` decides the response. */
  | { outcome: "existing"; record: IdempotencyRecord }
  /** Held for a different fingerprint. 409 Idempotency key conflict. */
  | { outcome: "conflict" };

/**
 * The minimal port.
 *
 * `now` is passed in rather than read, so retention and staleness are testable
 * without waiting 24 hours or faking a global clock.
 */
export interface IdempotencyStore {
  /**
   * Atomically claim `key` for `fingerprint`.
   *
   * Must be atomic for BOTH `NEW → IN_PROGRESS` and `FAILED_SAFE →
   * IN_PROGRESS` (ADR-012 as amended). Two concurrent callers must never both
   * receive `claimed`.
   */
  claim(key: string, fingerprint: string, now: number): Promise<ClaimOutcome>;
  complete(key: string, result: StoredResult, now: number): Promise<void>;
  fail(key: string, mode: "FAILED_SAFE" | "AMBIGUOUS", now: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Key validation
// ---------------------------------------------------------------------------

/**
 * `Idempotency-Key` is REQUIRED on POST /api/exports/anylist and must be 1–128
 * characters. Anything else is `400 Invalid idempotency key`.
 */
export function isValidIdempotencyKey(key: string | undefined): boolean {
  if (key === undefined) return false;
  return key.length >= KEY_MIN_LENGTH && key.length <= KEY_MAX_LENGTH;
}

// ---------------------------------------------------------------------------
// The policy table: what the endpoint must do for the state it finds.
// ---------------------------------------------------------------------------

export type ExportAction =
  /** Call createRecipe. The only action permitted to write to AnyList. */
  | "EXECUTE"
  /** Return the recorded result with idempotent: true. No write. */
  | "REPLAY"
  /** 409 Idempotency key conflict. */
  | "REJECT_CONFLICT"
  /** 409 Export already in progress. */
  | "REJECT_IN_PROGRESS"
  /** 409 Export outcome unknown. */
  | "REJECT_AMBIGUOUS";

export const REQUIRED_ACTION: Record<IdempotencyState, ExportAction> = {
  NEW: "EXECUTE",
  IN_PROGRESS: "REJECT_IN_PROGRESS",
  COMPLETED: "REPLAY",
  // "Atomically re-claim → IN_PROGRESS, then retry." login_failed is currently
  // the only failure carrying positive evidence that no write was attempted.
  FAILED_SAFE: "EXECUTE",
  AMBIGUOUS: "REJECT_AMBIGUOUS",
};

/** The single rule ADR-012 exists to enforce. */
export function mayCallCreateRecipe(action: ExportAction): boolean {
  return action === "EXECUTE";
}

/** Every status and error string is now pinned by the approved contract. */
export const REQUIRED_RESPONSE: Record<ExportAction, { status: number; error: string | null }> = {
  EXECUTE: { status: 200, error: null },
  REPLAY: { status: 200, error: null },
  REJECT_CONFLICT: { status: 409, error: "Idempotency key conflict" },
  REJECT_IN_PROGRESS: { status: 409, error: "Export already in progress" },
  REJECT_AMBIGUOUS: { status: 409, error: "Export outcome unknown" },
};

// ---------------------------------------------------------------------------
// The conformance suite.
// ---------------------------------------------------------------------------

export interface ConformanceOptions {
  /** A fresh, empty store for each test. */
  createStore: () => IdempotencyStore | Promise<IdempotencyStore>;
  /**
   * How long an IN_PROGRESS record may sit before it counts as stale. Supply it
   * to run the staleness tests. Whatever the value, a stale IN_PROGRESS must
   * never be handed back as `claimed` — expiry is not evidence of safety.
   */
  staleAfterMs?: number;
}

const T0 = 1_700_000_000_000;
const RESULT: StoredResult = {
  status: 200,
  body: { success: true, saved: { id: "anylist-1" } },
  requestId: "req_original",
};

export function runIdempotencyStoreConformance({
  createStore,
  staleAfterMs,
}: ConformanceOptions): void {
  describe("claiming a key", () => {
    it("claims an unseen key", async () => {
      const store = await createStore();

      expect(await store.claim("k1", "fp-a", T0)).toEqual({ outcome: "claimed" });
    });

    it("keeps separate keys independent", async () => {
      const store = await createStore();
      await store.claim("k1", "fp-a", T0);

      expect(await store.claim("k2", "fp-b", T0)).toEqual({ outcome: "claimed" });
    });

    it("accepts a key at the 128-character maximum", async () => {
      const store = await createStore();

      expect(await store.claim("x".repeat(KEY_MAX_LENGTH), "fp-a", T0)).toEqual({
        outcome: "claimed",
      });
    });
  });

  describe("same key, same request", () => {
    it("reports IN_PROGRESS while the first export is still running", async () => {
      const store = await createStore();
      await store.claim("k1", "fp-a", T0);

      expect(await store.claim("k1", "fp-a", T0 + 10)).toEqual({
        outcome: "existing",
        record: { state: "IN_PROGRESS", result: null },
      });
    });

    it("replays the recorded result once completed", async () => {
      const store = await createStore();
      await store.claim("k1", "fp-a", T0);
      await store.complete("k1", RESULT, T0 + 100);

      expect(await store.claim("k1", "fp-a", T0 + 200)).toEqual({
        outcome: "existing",
        record: { state: "COMPLETED", result: RESULT },
      });
    });

    it("keeps the originating request id on the recorded result", async () => {
      // It becomes `originalRequestId` on a replay. Without it a replay is
      // indistinguishable from a fresh success in logs.
      const store = await createStore();
      await store.claim("k1", "fp-a", T0);
      await store.complete("k1", RESULT, T0 + 100);

      const claim = await store.claim("k1", "fp-a", T0 + 200);

      expect(claim.outcome === "existing" && claim.record.result?.requestId).toBe("req_original");
    });

    it("re-claims a FAILED_SAFE record so the export can be retried", async () => {
      // The approved amendment: FAILED_SAFE → IN_PROGRESS must be an atomic
      // re-claim, not merely a readable state.
      const store = await createStore();
      await store.claim("k1", "fp-a", T0);
      await store.fail("k1", "FAILED_SAFE", T0 + 100);

      expect(await store.claim("k1", "fp-a", T0 + 200)).toEqual({ outcome: "claimed" });
    });

    it("never re-claims an AMBIGUOUS record", async () => {
      const store = await createStore();
      await store.claim("k1", "fp-a", T0);
      await store.fail("k1", "AMBIGUOUS", T0 + 100);

      expect(await store.claim("k1", "fp-a", T0 + 200)).toEqual({
        outcome: "existing",
        record: { state: "AMBIGUOUS", result: null },
      });
    });

    it("never downgrades a COMPLETED record to a retryable one", async () => {
      const store = await createStore();
      await store.claim("k1", "fp-a", T0);
      await store.complete("k1", RESULT, T0 + 100);

      const claim = await store.claim("k1", "fp-a", T0 + 200);

      expect(claim.outcome).toBe("existing");
      expect(claim.outcome === "existing" && claim.record.state).toBe("COMPLETED");
    });
  });

  describe("same key, different request", () => {
    it.each([
      ["in progress", null],
      ["completed", "complete"],
      ["failed safe", "FAILED_SAFE"],
      ["ambiguous", "AMBIGUOUS"],
    ] as const)("conflicts when the original is %s", async (_label, finish) => {
      const store = await createStore();
      await store.claim("k1", "fp-a", T0);
      if (finish === "complete") await store.complete("k1", RESULT, T0 + 10);
      else if (finish !== null) await store.fail("k1", finish, T0 + 10);

      expect(await store.claim("k1", "fp-b", T0 + 20)).toEqual({ outcome: "conflict" });
    });

    it("conflicts on the fingerprint, never on the key alone", async () => {
      const store = await createStore();
      await store.claim("k1", "fp-a", T0);

      expect(await store.claim("k1", "fp-a", T0 + 5)).not.toEqual({ outcome: "conflict" });
      expect(await store.claim("k1", "fp-b", T0 + 5)).toEqual({ outcome: "conflict" });
    });

    it("conflicts on a FAILED_SAFE record rather than re-claiming it", async () => {
      // A retry is only a retry if it is the same request.
      const store = await createStore();
      await store.claim("k1", "fp-a", T0);
      await store.fail("k1", "FAILED_SAFE", T0 + 10);

      expect(await store.claim("k1", "fp-b", T0 + 20)).toEqual({ outcome: "conflict" });
    });
  });

  describe("concurrency", () => {
    it("lets exactly one of many concurrent claims win", async () => {
      // "The store must support atomic state transitions — specifically
      // NEW → IN_PROGRESS ... or two concurrent same-key requests can both
      // believe they won." Everything downstream rests on this.
      const store = await createStore();

      const claims = await Promise.all(
        Array.from({ length: 20 }, () => store.claim("k1", "fp-a", T0)),
      );

      expect(claims.filter((claim) => claim.outcome === "claimed")).toHaveLength(1);
      expect(claims.filter((claim) => claim.outcome === "existing")).toHaveLength(19);
    });

    it("lets exactly one concurrent re-claim of a FAILED_SAFE record win", async () => {
      // The amended rule names this transition specifically, and it is the
      // easier of the two to implement non-atomically by accident.
      const store = await createStore();
      await store.claim("k1", "fp-a", T0);
      await store.fail("k1", "FAILED_SAFE", T0 + 10);

      const claims = await Promise.all(
        Array.from({ length: 10 }, () => store.claim("k1", "fp-a", T0 + 20)),
      );

      expect(claims.filter((claim) => claim.outcome === "claimed")).toHaveLength(1);
    });

    it("claims different keys concurrently without interference", async () => {
      const store = await createStore();

      const claims = await Promise.all([
        store.claim("k1", "fp-a", T0),
        store.claim("k2", "fp-a", T0),
        store.claim("k3", "fp-a", T0),
      ]);

      expect(claims.every((claim) => claim.outcome === "claimed")).toBe(true);
    });
  });

  describe("stale IN_PROGRESS is not evidence of safety", () => {
    const stale = staleAfterMs ?? 0;

    it.runIf(staleAfterMs !== undefined)(
      "never hands back a stale IN_PROGRESS record as claimable",
      async () => {
        // "A stale IN_PROGRESS record must not automatically become retryable.
        // Absent positive evidence that createRecipe was never reached, a stale
        // IN_PROGRESS is treated as AMBIGUOUS. Expiry is not evidence of safety."
        const store = await createStore();
        await store.claim("k1", "fp-a", T0);

        const claim = await store.claim("k1", "fp-a", T0 + stale + 1000);

        expect(claim.outcome).not.toBe("claimed");
      },
    );

    it.runIf(staleAfterMs !== undefined)("reports a stale IN_PROGRESS as AMBIGUOUS", async () => {
      const store = await createStore();
      await store.claim("k1", "fp-a", T0);

      const claim = await store.claim("k1", "fp-a", T0 + stale + 1000);

      expect(claim.outcome === "existing" && claim.record.state).toBe("AMBIGUOUS");
    });

    it.runIf(staleAfterMs !== undefined)(
      "still conflicts on a different fingerprint once stale",
      async () => {
        const store = await createStore();
        await store.claim("k1", "fp-a", T0);

        expect(await store.claim("k1", "fp-b", T0 + stale + 1000)).toEqual({ outcome: "conflict" });
      },
    );
  });

  describe("retention", () => {
    it("still replays a completed record just under 24 hours old", async () => {
      const store = await createStore();
      await store.claim("k1", "fp-a", T0);
      await store.complete("k1", RESULT, T0);

      expect((await store.claim("k1", "fp-a", T0 + RETENTION_MS - 1000)).outcome).toBe("existing");
    });

    it("treats a completed record older than 24 hours as gone", async () => {
      // See QA-021. This is the documented consequence of a 24-hour TTL: the
      // same key with the same request becomes claimable again and a retry WILL
      // write to AnyList a second time. Retention bounds the guarantee.
      const store = await createStore();
      await store.claim("k1", "fp-a", T0);
      await store.complete("k1", RESULT, T0);

      expect(await store.claim("k1", "fp-a", T0 + RETENTION_MS + 1000)).toEqual({
        outcome: "claimed",
      });
    });

    it("does not conflict against an expired record", async () => {
      const store = await createStore();
      await store.claim("k1", "fp-a", T0);
      await store.complete("k1", RESULT, T0);

      expect(await store.claim("k1", "fp-b", T0 + RETENTION_MS + 1000)).toEqual({
        outcome: "claimed",
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Request fingerprint (ADR-018)
// ---------------------------------------------------------------------------

/**
 * Conformance for the fingerprint step: validate → normalise → deterministically
 * serialise → SHA-256.
 *
 * The function under test takes the **already validated and normalised** request
 * value, not raw bytes. That ordering is the whole point of ADR-018 and is why
 * these tests pass parsed values rather than strings.
 */
export function runFingerprintConformance(fingerprint: (value: unknown) => string): void {
  const recipe = {
    schemaVersion: 1,
    recipe: {
      title: "Cottage Cheese Brownies",
      servings: 9,
      ingredients: [
        { name: "cottage cheese", quantity: "16" },
        { name: "cocoa powder", quantity: "1/2" },
      ],
      instructions: ["Blend until smooth.", "Bake."],
    },
  };

  describe("request fingerprint", () => {
    it("is a SHA-256 hex digest", () => {
      expect(fingerprint(recipe)).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is stable across repeated calls", () => {
      expect(fingerprint(recipe)).toBe(fingerprint(recipe));
    });

    it("ignores object key order", () => {
      // The false-conflict ADR-018 exists to prevent: a client re-serialising an
      // identical recipe with a different encoder must not get a 409.
      const reordered = {
        recipe: {
          instructions: recipe.recipe.instructions,
          ingredients: recipe.recipe.ingredients.map((i) => ({ quantity: i.quantity, name: i.name })),
          servings: recipe.recipe.servings,
          title: recipe.recipe.title,
        },
        schemaVersion: recipe.schemaVersion,
      };

      expect(fingerprint(reordered)).toBe(fingerprint(recipe));
    });

    it("is unaffected by the whitespace of any original encoding", () => {
      // Fingerprinting happens after parsing, so encoding whitespace cannot
      // reach it at all. Round-tripping through JSON proves the input is a
      // value, not a byte string.
      expect(fingerprint(JSON.parse(JSON.stringify(recipe, null, 4)) as unknown)).toBe(
        fingerprint(recipe),
      );
    });

    it("changes when any recipe value changes", () => {
      const edited = { ...recipe, recipe: { ...recipe.recipe, servings: 4 } };

      expect(fingerprint(edited)).not.toBe(fingerprint(recipe));
    });

    it("treats ingredient order as significant", () => {
      // Arrays carry meaning here. A normalisation that sorted them would make
      // two genuinely different recipes share a fingerprint, and the second
      // export would be silently swallowed as a replay.
      const swapped = {
        ...recipe,
        recipe: { ...recipe.recipe, ingredients: [...recipe.recipe.ingredients].reverse() },
      };

      expect(fingerprint(swapped)).not.toBe(fingerprint(recipe));
    });

    it("treats instruction order as significant", () => {
      const swapped = {
        ...recipe,
        recipe: { ...recipe.recipe, instructions: [...recipe.recipe.instructions].reverse() },
      };

      expect(fingerprint(swapped)).not.toBe(fingerprint(recipe));
    });

    it("distinguishes null from absent", () => {
      expect(fingerprint({ a: null })).not.toBe(fingerprint({}));
    });
  });
}
