import { describe, expect, it } from "vitest";

import type { IdempotencyStore } from "../../src/idempotency/store.js";

/**
 * An independent conformance suite for the frozen idempotency semantics
 * (contracts.md "Idempotency-Key", ADR-012, ADR-017, ADR-018, ADR-025).
 *
 * Written against the `IdempotencyStore` interface rather than any one
 * implementation, so the same assertions run against the in-process store here
 * and against real Upstash Redis in a live gate:
 *
 *   describe("upstash", () => runIdempotencyStoreConformance({ createStore }));
 *
 * Deliberately not a copy of the implementation's own unit tests. It asserts
 * only what the *contract* requires, from the outside — which is what makes it
 * useful for catching one implementation drifting from another.
 */

/** contracts.md: "Length 1–128 characters." */
export const KEY_MIN_LENGTH = 1;
export const KEY_MAX_LENGTH = 128;

/**
 * `Idempotency-Key` is REQUIRED on POST /api/exports/anylist and must be 1–128
 * characters. Anything else is `400 Invalid idempotency key`.
 */
export function isValidIdempotencyKey(key: string | undefined): boolean {
  if (key === undefined) return false;
  return key.length >= KEY_MIN_LENGTH && key.length <= KEY_MAX_LENGTH;
}

// ---------------------------------------------------------------------------
// The policy table: what the endpoint must do for each claim outcome.
// ---------------------------------------------------------------------------

export type ClaimStatus = "claimed" | "conflict" | "in_progress" | "ambiguous" | "completed";

export type ExportAction =
  /** Call createRecipe. The only action permitted to write to AnyList. */
  | "EXECUTE"
  /** Return the recorded result with idempotent: true. No write. */
  | "REPLAY"
  | "REJECT_CONFLICT"
  | "REJECT_IN_PROGRESS"
  | "REJECT_AMBIGUOUS";

export const REQUIRED_ACTION: Record<ClaimStatus, ExportAction> = {
  // Covers both a first claim and a FAILED_SAFE re-claim: the store collapses
  // them, because both mean "no write has happened and you may proceed".
  claimed: "EXECUTE",
  completed: "REPLAY",
  conflict: "REJECT_CONFLICT",
  in_progress: "REJECT_IN_PROGRESS",
  ambiguous: "REJECT_AMBIGUOUS",
};

/** The single rule ADR-012 exists to enforce. */
export function mayCallCreateRecipe(action: ExportAction): boolean {
  return action === "EXECUTE";
}

export const REQUIRED_RESPONSE: Record<ExportAction, { status: number; error: string | null }> = {
  EXECUTE: { status: 200, error: null },
  REPLAY: { status: 200, error: null },
  REJECT_CONFLICT: { status: 409, error: "Idempotency key conflict" },
  REJECT_IN_PROGRESS: { status: 409, error: "Export already in progress" },
  REJECT_AMBIGUOUS: { status: 409, error: "Export outcome unknown" },
};

// ---------------------------------------------------------------------------
// Store conformance
// ---------------------------------------------------------------------------

export interface ConformanceOptions {
  /** A fresh, empty store for each test. */
  createStore: () => IdempotencyStore | Promise<IdempotencyStore>;
  /** Record TTL for COMPLETED, in ms. Supply it to run the retention tests. */
  completedRetentionMs?: number;
  /** Record TTL for AMBIGUOUS, in ms. Supply it to run the retention tests. */
  ambiguousRetentionMs?: number;
}

/**
 * Anchored to the real clock rather than a fixed past instant.
 *
 * Every time in this suite is a relative offset from T0, so the arithmetic is
 * deterministic — but `IdempotencyStore.read` takes no clock parameter and an
 * implementation may reasonably use the real one, which would see records
 * written at a hardcoded 2023 timestamp as long expired.
 */
const T0 = Date.now();
const LEASE_MS = 150_000;
const RESULT = { id: "anylist-recipe-1", name: "Cottage Cheese Brownies" };

export function runIdempotencyStoreConformance({
  createStore,
  completedRetentionMs,
  ambiguousRetentionMs,
}: ConformanceOptions): void {
  const claim = (
    store: IdempotencyStore,
    over: Partial<{ key: string; fingerprint: string; requestId: string; now: number }> = {},
  ) =>
    store.claim({
      key: over.key ?? "k1",
      fingerprint: over.fingerprint ?? "fp-a",
      requestId: over.requestId ?? "req-1",
      now: over.now ?? T0,
      leaseMs: LEASE_MS,
    });

  describe("claiming", () => {
    it("claims an unseen key", async () => {
      const store = await createStore();

      expect(await claim(store)).toEqual({ status: "claimed" });
    });

    it("keeps separate keys independent", async () => {
      const store = await createStore();
      await claim(store);

      expect(await claim(store, { key: "k2", fingerprint: "fp-b" })).toEqual({ status: "claimed" });
    });

    it("accepts a key at the 128-character maximum", async () => {
      const store = await createStore();

      expect(await claim(store, { key: "x".repeat(KEY_MAX_LENGTH) })).toEqual({ status: "claimed" });
    });

    it("records the claiming request id", async () => {
      const store = await createStore();
      await claim(store, { requestId: "req-original" });

      expect((await store.read("k1"))?.requestId).toBe("req-original");
    });
  });

  describe("same key, same request", () => {
    it("reports in_progress while the first export holds a live lease", async () => {
      const store = await createStore();
      await claim(store);

      expect(await claim(store, { requestId: "req-2", now: T0 + 10 })).toEqual({
        status: "in_progress",
      });
    });

    it("replays a completed record with its original request id", async () => {
      // `originalRequestId` is what makes a replay distinguishable from a fresh
      // success in logs.
      const store = await createStore();
      await claim(store, { requestId: "req-original" });
      await store.complete("k1", "req-original", RESULT, T0 + 100);

      expect(await claim(store, { requestId: "req-2", now: T0 + 200 })).toEqual({
        status: "completed",
        result: RESULT,
        originalRequestId: "req-original",
      });
    });

    it("re-claims a FAILED_SAFE record so the export can be retried", async () => {
      // ADR-012 as amended: FAILED_SAFE → IN_PROGRESS is an atomic re-claim.
      const store = await createStore();
      await claim(store);
      await store.fail("k1", "req-1", "FAILED_SAFE", "login_failed", T0 + 100);

      expect(await claim(store, { requestId: "req-2", now: T0 + 200 })).toEqual({
        status: "claimed",
      });
    });

    it("never re-claims an AMBIGUOUS record", async () => {
      const store = await createStore();
      await claim(store);
      await store.fail("k1", "req-1", "AMBIGUOUS", "create_failed", T0 + 100);

      expect(await claim(store, { requestId: "req-2", now: T0 + 200 })).toEqual({
        status: "ambiguous",
      });
    });

    it("never downgrades a COMPLETED record to something retryable", async () => {
      const store = await createStore();
      await claim(store);
      await store.complete("k1", "req-1", RESULT, T0 + 100);

      for (const now of [T0 + 200, T0 + LEASE_MS * 10]) {
        expect((await claim(store, { requestId: "req-x", now })).status).toBe("completed");
      }
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
      await claim(store);
      if (finish === "complete") await store.complete("k1", "req-1", RESULT, T0 + 10);
      else if (finish !== null) await store.fail("k1", "req-1", finish, "create_failed", T0 + 10);

      expect(await claim(store, { fingerprint: "fp-b", now: T0 + 20 })).toEqual({
        status: "conflict",
      });
    });

    it("checks the fingerprint before the state, so a mismatch can never claim", async () => {
      // Ordering matters: a FAILED_SAFE record is re-claimable, but only by the
      // same request. Checking state first would let a different body take it.
      const store = await createStore();
      await claim(store);
      await store.fail("k1", "req-1", "FAILED_SAFE", "login_failed", T0 + 10);

      expect(await claim(store, { fingerprint: "fp-b", now: T0 + 20 })).toEqual({
        status: "conflict",
      });
      expect(await claim(store, { fingerprint: "fp-a", now: T0 + 20 })).toEqual({
        status: "claimed",
      });
    });
  });

  describe("concurrency", () => {
    it("lets exactly one of many concurrent claims win", async () => {
      const store = await createStore();

      const claims = await Promise.all(
        Array.from({ length: 20 }, (_unused, index) => claim(store, { requestId: `req-${index}` })),
      );

      expect(claims.filter((result) => result.status === "claimed")).toHaveLength(1);
      expect(claims.filter((result) => result.status === "in_progress")).toHaveLength(19);
    });

    it("lets exactly one concurrent re-claim of a FAILED_SAFE record win", async () => {
      // The transition most easily made non-atomic by accident, because it is
      // the one that reads a record and then writes a different state.
      const store = await createStore();
      await claim(store);
      await store.fail("k1", "req-1", "FAILED_SAFE", "login_failed", T0 + 10);

      const claims = await Promise.all(
        Array.from({ length: 10 }, (_unused, index) =>
          claim(store, { requestId: `retry-${index}`, now: T0 + 20 }),
        ),
      );

      expect(claims.filter((result) => result.status === "claimed")).toHaveLength(1);
    });

    it("claims different keys concurrently without interference", async () => {
      const store = await createStore();

      const claims = await Promise.all(["k1", "k2", "k3"].map((key) => claim(store, { key })));

      expect(claims.every((result) => result.status === "claimed")).toBe(true);
    });
  });

  describe("a stale lease is not evidence of safety (ADR-025)", () => {
    it("never returns a stale IN_PROGRESS record as claimable", async () => {
      const store = await createStore();
      await claim(store);

      const stale = await claim(store, { requestId: "req-2", now: T0 + LEASE_MS + 1000 });

      expect(stale.status).not.toBe("claimed");
    });

    it("transitions a stale IN_PROGRESS to AMBIGUOUS", async () => {
      const store = await createStore();
      await claim(store);

      expect(await claim(store, { requestId: "req-2", now: T0 + LEASE_MS + 1000 })).toEqual({
        status: "ambiguous",
      });
    });

    it("keeps the record rather than deleting it, so the state persists", async () => {
      const store = await createStore();
      await claim(store);
      await claim(store, { requestId: "req-2", now: T0 + LEASE_MS + 1000 });

      expect((await store.read("k1"))?.state).toBe("AMBIGUOUS");
    });

    it("still conflicts on a different fingerprint once stale", async () => {
      const store = await createStore();
      await claim(store);

      expect(await claim(store, { fingerprint: "fp-b", now: T0 + LEASE_MS + 1000 })).toEqual({
        status: "conflict",
      });
    });
  });

  describe("state-dependent retention (ADR-025)", () => {
    it.runIf(completedRetentionMs !== undefined)(
      "still replays a completed record just inside its retention window",
      async () => {
        const store = await createStore();
        await claim(store);
        await store.complete("k1", "req-1", RESULT, T0);

        const within = T0 + (completedRetentionMs ?? 0) - 1000;
        expect((await claim(store, { requestId: "req-2", now: within })).status).toBe("completed");
      },
    );

    it.runIf(completedRetentionMs !== undefined)(
      "lets a completed record expire once its retention window passes",
      async () => {
        // Safe: the write is done and verified, so a later retry creating a
        // second recipe is the client's own doing, not something time did.
        const store = await createStore();
        await claim(store);
        await store.complete("k1", "req-1", RESULT, T0);

        const after = T0 + (completedRetentionMs ?? 0) + 1000;
        expect(await claim(store, { requestId: "req-2", now: after })).toEqual({
          status: "claimed",
        });
      },
    );

    it.runIf(ambiguousRetentionMs !== undefined)(
      "keeps an AMBIGUOUS record far beyond the completed window",
      async () => {
        // The rule QA-021 asked for. A flat 24-hour TTL would have let an
        // ambiguous outcome become claimable *solely because time passed*, and
        // since deleteRecipe cannot clean up a duplicate (ADR-021), that write
        // would be unfixable.
        const store = await createStore();
        await claim(store);
        await store.fail("k1", "req-1", "AMBIGUOUS", "create_failed", T0);

        const wellPast = T0 + (completedRetentionMs ?? 0) * 2;
        expect((await claim(store, { requestId: "req-2", now: wellPast })).status).toBe("ambiguous");
      },
    );

    it.runIf(ambiguousRetentionMs !== undefined)(
      "keeps an abandoned IN_PROGRESS record beyond the completed window too",
      async () => {
        const store = await createStore();
        await claim(store);

        const wellPast = T0 + (completedRetentionMs ?? 0) * 2;
        expect((await claim(store, { requestId: "req-2", now: wellPast })).status).toBe("ambiguous");
      },
    );
  });

  describe("completion and failure only apply to the holder of the claim", () => {
    it("ignores a completion from a request that does not hold the claim", async () => {
      // A late reply from a superseded request must not overwrite the state the
      // current holder is about to write.
      const store = await createStore();
      await claim(store, { requestId: "req-1" });
      await store.complete("k1", "someone-else", RESULT, T0 + 50);

      expect((await store.read("k1"))?.state).toBe("IN_PROGRESS");
    });

    it("ignores a failure from a request that does not hold the claim", async () => {
      const store = await createStore();
      await claim(store, { requestId: "req-1" });
      await store.fail("k1", "someone-else", "FAILED_SAFE", "login_failed", T0 + 50);

      expect((await store.read("k1"))?.state).toBe("IN_PROGRESS");
    });

    it("reads back nothing for a key that was never claimed", async () => {
      const store = await createStore();

      expect(await store.read("never-seen")).toBeNull();
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
 * The function under test takes the **already validated and normalised**
 * request value, not raw bytes. That ordering is the point of ADR-018.
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
      expect(fingerprint(JSON.parse(JSON.stringify(recipe, null, 4)) as unknown)).toBe(
        fingerprint(recipe),
      );
    });

    it("changes when any recipe value changes", () => {
      expect(fingerprint({ ...recipe, recipe: { ...recipe.recipe, servings: 4 } })).not.toBe(
        fingerprint(recipe),
      );
    });

    it("treats ingredient order as significant", () => {
      // A normalisation that sorted arrays would make two genuinely different
      // recipes share a fingerprint, and the second export would be silently
      // swallowed as a replay.
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

    it("distinguishes a nested value change at any depth", () => {
      const edited = {
        ...recipe,
        recipe: {
          ...recipe.recipe,
          ingredients: [{ name: "cottage cheese", quantity: "8" }, recipe.recipe.ingredients[1]],
        },
      };

      expect(fingerprint(edited)).not.toBe(fingerprint(recipe));
    });
  });
}
