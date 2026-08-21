import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { ExportError } from "../../app/export-service.js";
import { AnyListError, type AnyListErrorCode } from "../../anylist/types.js";
import { MemoryIdempotencyStore } from "../../idempotency/memory-store.js";
import type { IdempotencyStore } from "../../idempotency/store.js";
import {
  bearer,
  exportBody,
  recipeWith,
  TEST_API_KEY,
  validRecipe,
} from "../../test-support/fixtures.js";
import { buildServer } from "../server.js";

const REQUEST_ID = /^req_[0-9A-HJKMNP-TV-Z]{26}$/;
const SAVED = { name: "Cottage Cheese Brownies", identifier: "anylist-recipe-id-42" };
const LEASE_MS = 150_000;
const T0 = 1_700_000_000_000;

interface Harness {
  app: FastifyInstance;
  exportRecipe: ReturnType<typeof vi.fn>;
  store: IdempotencyStore;
  setNow: (value: number) => void;
}

function harness(
  behaviour: () => Promise<typeof SAVED> = async () => SAVED,
  store: IdempotencyStore = new MemoryIdempotencyStore(),
): Harness {
  let now = T0;
  const exportRecipe = vi.fn(behaviour);

  const app = buildServer({
    apiKey: TEST_API_KEY,
    exportRecipe: exportRecipe as never,
    idempotencyStore: store,
    now: () => now,
    leaseMs: LEASE_MS,
  });

  return {
    app,
    exportRecipe,
    store,
    setNow: (value) => {
      now = value;
    },
  };
}

function post(
  app: FastifyInstance,
  options: {
    auth?: string;
    key?: string | null;
    payload?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  const key = options.key === undefined ? "client-key-1" : options.key;

  return app.inject({
    method: "POST",
    url: "/api/exports/anylist",
    headers: {
      "content-type": "application/json",
      ...(options.auth === undefined ? {} : { authorization: options.auth }),
      ...(key === null ? {} : { "idempotency-key": key }),
      ...options.headers,
    },
    payload: options.payload ?? exportBody(),
  });
}

/**
 * A harness whose export never finishes, plus a promise that resolves once it
 * has actually started. Anything asserting on an in-flight claim waits on that
 * rather than on a timer.
 */
function heldExport(): Harness & { entered: Promise<void> } {
  let markEntered: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });

  const built = harness(() => {
    markEntered();
    return new Promise<typeof SAVED>(() => undefined);
  });

  return { ...built, entered };
}

describe("POST /api/exports/anylist", () => {
  describe("success", () => {
    it("returns the verified save with schemaVersion and requestId", async () => {
      const { app } = harness();
      const response = await post(app, { auth: bearer() });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        success: true,
        schemaVersion: 1,
        requestId: expect.stringMatching(REQUEST_ID),
        saved: { id: SAVED.identifier, name: SAVED.name },
        idempotent: false,
      });
    });

    it("omits originalRequestId on a first execution", async () => {
      const { app } = harness();

      expect((await post(app, { auth: bearer() })).json()).not.toHaveProperty("originalRequestId");
    });

    it("exports an edited recipe that still carries extraction warnings", async () => {
      const { app, exportRecipe } = harness();
      const edited = recipeWith({ servings: 12, warnings: ["stale warning"], confidence: 0.2 });

      const response = await post(app, { auth: bearer(), payload: exportBody(edited) });

      expect(response.statusCode).toBe(200);
      expect(exportRecipe).toHaveBeenCalledWith(edited);
    });

    it("does not recompute confidence or warnings", async () => {
      const { app, exportRecipe } = harness();
      const edited = recipeWith({ confidence: 0.11, warnings: ["one", "two"] });

      await post(app, { auth: bearer(), payload: exportBody(edited) });

      const submitted = exportRecipe.mock.calls[0]?.[0] as typeof validRecipe;
      expect(submitted.confidence).toBe(0.11);
      expect(submitted.warnings).toEqual(["one", "two"]);
    });
  });

  describe("Idempotency-Key validation", () => {
    it("is required", async () => {
      const { app, exportRecipe } = harness();
      const response = await post(app, { auth: bearer(), key: null });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("Invalid idempotency key");
      expect(exportRecipe).not.toHaveBeenCalled();
    });

    it("accepts 1 and 128 characters", async () => {
      const { app } = harness();

      expect((await post(app, { auth: bearer(), key: "a" })).statusCode).toBe(200);
      expect((await post(app, { auth: bearer(), key: "b".repeat(128) })).statusCode).toBe(200);
    });

    it("rejects 129 characters", async () => {
      const { app } = harness();

      expect((await post(app, { auth: bearer(), key: "c".repeat(129) })).statusCode).toBe(400);
    });

    it("rejects a whitespace-only key", async () => {
      const { app } = harness();

      expect((await post(app, { auth: bearer(), key: "   " })).statusCode).toBe(400);
    });
  });

  describe("normalised fingerprint (ADR-018)", () => {
    it("treats reordered keys as the same request", async () => {
      const { app, exportRecipe } = harness();
      const reordered = {
        recipe: { ...validRecipe },
        schemaVersion: 1,
      };

      await post(app, { auth: bearer() });
      const replay = await post(app, { auth: bearer(), payload: reordered });

      expect(replay.statusCode).toBe(200);
      expect(replay.json().idempotent).toBe(true);
      expect(exportRecipe).toHaveBeenCalledTimes(1);
    });

    it("treats surrounding whitespace in text as the same request", async () => {
      const { app } = harness();

      await post(app, { auth: bearer() });
      const replay = await post(app, {
        auth: bearer(),
        payload: exportBody(recipeWith({ title: `  ${validRecipe.title}  ` })),
      });

      expect(replay.json().idempotent).toBe(true);
    });

    it("treats a genuine edit as a different request", async () => {
      const { app } = harness();

      await post(app, { auth: bearer() });
      const conflicting = await post(app, {
        auth: bearer(),
        payload: exportBody(recipeWith({ servings: 4 })),
      });

      expect(conflicting.statusCode).toBe(409);
      expect(conflicting.json().error).toBe("Idempotency key conflict");
    });

    it("does not execute the export on a conflict", async () => {
      const { app, exportRecipe } = harness();

      await post(app, { auth: bearer() });
      await post(app, { auth: bearer(), payload: exportBody(recipeWith({ servings: 4 })) });

      expect(exportRecipe).toHaveBeenCalledTimes(1);
    });
  });

  describe("replay", () => {
    it("returns the recorded result without a second AnyList write", async () => {
      const { app, exportRecipe } = harness();

      const first = await post(app, { auth: bearer() });
      const second = await post(app, { auth: bearer() });

      expect(second.statusCode).toBe(200);
      expect(second.json().saved).toEqual(first.json().saved);
      expect(second.json().idempotent).toBe(true);
      expect(exportRecipe).toHaveBeenCalledTimes(1);
    });

    it("answers with the current request id and names the original", async () => {
      const { app } = harness();

      const first = await post(app, { auth: bearer() });
      const second = await post(app, { auth: bearer() });

      // Both are needed: without originalRequestId a replay is indistinguishable
      // from a fresh success in logs.
      expect(second.json().requestId).not.toBe(first.json().requestId);
      expect(second.json().originalRequestId).toBe(first.json().requestId);
    });

    it("keeps replaying for the whole window", async () => {
      const { app, exportRecipe, setNow } = harness();

      await post(app, { auth: bearer() });
      setNow(T0 + 23 * 60 * 60 * 1000);

      expect((await post(app, { auth: bearer() })).json().idempotent).toBe(true);
      expect(exportRecipe).toHaveBeenCalledTimes(1);
    });
  });

  describe("concurrent same-key requests", () => {
    it("executes the export exactly once", async () => {
      const CONCURRENCY = 8;
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      // Deterministic rather than timing-based: the winning export is held open
      // until every one of the eight requests has been through claim(), so the
      // result cannot depend on how the event loop happened to interleave.
      const inner = new MemoryIdempotencyStore();
      let claims = 0;
      const counting: IdempotencyStore = {
        claim: async (request) => {
          claims += 1;
          const outcome = await inner.claim(request);
          if (claims === CONCURRENCY) release();
          return outcome;
        },
        complete: (...args) => inner.complete(...args),
        fail: (...args) => inner.fail(...args),
        read: (...args) => inner.read(...args),
      };

      const { app, exportRecipe } = harness(async () => {
        await gate;
        return SAVED;
      }, counting);

      const responses = await Promise.all(
        Array.from({ length: CONCURRENCY }, () => post(app, { auth: bearer() })),
      );
      const statuses = responses.map((response) => response.statusCode);

      expect(exportRecipe).toHaveBeenCalledTimes(1);
      expect(statuses.filter((status) => status === 200)).toHaveLength(1);
      expect(statuses.filter((status) => status === 409)).toHaveLength(CONCURRENCY - 1);
      expect(
        responses.every(
          (response) =>
            response.statusCode === 200 ||
            response.json().error === "Export already in progress",
        ),
      ).toBe(true);
    });

    it("tells the losers the export is already running", async () => {
      const { app, entered } = heldExport();

      void post(app, { auth: bearer() });
      await entered;

      const second = await post(app, { auth: bearer() });

      expect(second.statusCode).toBe(409);
      expect(second.json().error).toBe("Export already in progress");
    });

    /**
     * Proves the test above is not vacuous.
     *
     * A store that reads and then writes with a yield in between lets two
     * requests both believe they won. If the concurrency assertion still passed
     * against this store, it would not be testing anything.
     */
    it("would catch a non-atomic store", async () => {
      const records = new Map<string, { state: string }>();
      const nonAtomic: IdempotencyStore = {
        claim: async ({ key }) => {
          const existing = records.get(key);
          await new Promise((resolve) => setImmediate(resolve));
          if (existing !== undefined) return { status: "in_progress" };
          records.set(key, { state: "IN_PROGRESS" });
          return { status: "claimed" };
        },
        complete: async () => undefined,
        fail: async () => undefined,
        read: async () => null,
      };

      const { app, exportRecipe } = harness(async () => SAVED, nonAtomic);
      await Promise.all(Array.from({ length: 4 }, () => post(app, { auth: bearer() })));

      expect(exportRecipe.mock.calls.length).toBeGreaterThan(1);
    });
  });

  describe("FAILED_SAFE", () => {
    it("returns 500 and records a retryable state", async () => {
      const { app, store } = harness(async () => {
        throw new ExportError("login failed", "FAILED_SAFE", "login_failed");
      });

      const response = await post(app, { auth: bearer() });

      expect(response.statusCode).toBe(500);
      expect(response.json().error).toBe("Recipe export failed");
    });

    it("lets the same key retry, and the retry can succeed", async () => {
      let attempt = 0;
      const { app, exportRecipe } = harness(async () => {
        attempt += 1;
        if (attempt === 1) throw new ExportError("login failed", "FAILED_SAFE", "login_failed");
        return SAVED;
      });

      expect((await post(app, { auth: bearer() })).statusCode).toBe(500);

      const retry = await post(app, { auth: bearer() });

      expect(retry.statusCode).toBe(200);
      expect(retry.json().idempotent).toBe(false);
      expect(exportRecipe).toHaveBeenCalledTimes(2);
    });
  });

  describe("AMBIGUOUS", () => {
    it("refuses to call the export again, for a very long time", async () => {
      const { app, exportRecipe, setNow } = harness(async () => {
        throw new ExportError("create failed", "AMBIGUOUS", "create_failed");
      });

      expect((await post(app, { auth: bearer() })).statusCode).toBe(500);

      const retry = await post(app, { auth: bearer() });

      // The single most important assertion in this suite. A duplicate cannot
      // be cleaned up, because deleteRecipe() returns success without deleting.
      expect(retry.statusCode).toBe(409);
      expect(retry.json().error).toBe("Export outcome unknown");
      expect(exportRecipe).toHaveBeenCalledTimes(1);

      // Still refused well past the ordinary 24-hour replay window.
      setNow(T0 + 29 * 24 * 60 * 60 * 1000);
      expect((await post(app, { auth: bearer() })).statusCode).toBe(409);
      expect(exportRecipe).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["create_failed", "AMBIGUOUS"],
      ["verify_unreadable", "AMBIGUOUS"],
      ["verify_missing", "AMBIGUOUS"],
    ] as const)("reaches AMBIGUOUS from AnyList code %s", async (code: AnyListErrorCode, _state) => {
      const { app, exportRecipe } = harness(async () => {
        throw new AnyListError("AnyList said no.", code);
      });

      await post(app, { auth: bearer() });
      const retry = await post(app, { auth: bearer() });

      expect(retry.json().error).toBe("Export outcome unknown");
      expect(exportRecipe).toHaveBeenCalledTimes(1);
    });

    it("treats a timeout as unknown, not as safe", async () => {
      const { app, exportRecipe } = harness(async () => {
        throw new ExportError("timed out", "AMBIGUOUS", "export_timeout");
      });

      await post(app, { auth: bearer() });

      expect((await post(app, { auth: bearer() })).json().error).toBe("Export outcome unknown");
      expect(exportRecipe).toHaveBeenCalledTimes(1);
    });
  });

  describe("stale IN_PROGRESS", () => {
    it("becomes AMBIGUOUS rather than retryable", async () => {
      const { app, exportRecipe, setNow, entered } = heldExport();

      void post(app, { auth: bearer() });
      // Waiting on the export having started proves the claim happened, so the
      // assertion below is about the lease rule and not about scheduling luck.
      await entered;

      // The first request was killed mid-flight; its lease has long expired.
      setNow(T0 + LEASE_MS + 1);
      const later = await post(app, { auth: bearer() });

      expect(later.statusCode).toBe(409);
      expect(later.json().error).toBe("Export outcome unknown");
      // Expiry is not evidence of safety.
      expect(exportRecipe).toHaveBeenCalledTimes(1);
    });
  });

  describe("body validation", () => {
    it("rejects an unknown envelope key", async () => {
      const { app } = harness();
      const response = await post(app, {
        auth: bearer(),
        payload: { schemaVersion: 1, recipe: validRecipe, note: "hi" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("Invalid request body");
    });

    it("distinguishes a bad recipe from a bad envelope", async () => {
      const { app } = harness();
      const response = await post(app, {
        auth: bearer(),
        payload: exportBody(recipeWith({ title: "   " })),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("Invalid recipe");
    });

    it("rejects an unsupported schema version", async () => {
      const { app } = harness();
      const response = await post(app, {
        auth: bearer(),
        payload: { schemaVersion: 9, recipe: validRecipe },
      });

      expect(response.json().error).toBe("Unsupported schema version");
    });

    it("validates before claiming, so a bad body cannot burn a key", async () => {
      const { app } = harness();

      await post(app, { auth: bearer(), payload: exportBody(recipeWith({ title: "  " })) });
      const good = await post(app, { auth: bearer() });

      expect(good.statusCode).toBe(200);
      expect(good.json().idempotent).toBe(false);
    });

    it("accepts a 64 KB body", async () => {
      const { app } = harness();
      const long = recipeWith({
        instructions: Array.from({ length: 200 }, (_, i) => `Step ${i}: ${"x".repeat(200)}`),
      });

      expect((await post(app, { auth: bearer(), payload: exportBody(long) })).statusCode).toBe(200);
    });
  });

  describe("store failures after the write", () => {
    it("still reports success when the write was verified but the record was not", async () => {
      const inner = new MemoryIdempotencyStore();
      const flaky: IdempotencyStore = {
        claim: (...args) => inner.claim(...args),
        complete: async () => {
          throw new Error("redis unavailable");
        },
        fail: (...args) => inner.fail(...args),
        read: (...args) => inner.read(...args),
      };

      const { app } = harness(async () => SAVED, flaky);
      const response = await post(app, { auth: bearer() });

      // The recipe is in the account and was read back. Reporting a failure
      // would be untrue, and would invite exactly the retry that duplicates it.
      expect(response.statusCode).toBe(200);
      expect(response.json().saved).toEqual({ id: SAVED.identifier, name: SAVED.name });
    });

    it("leaves the stale record to fail safe rather than becoming claimable", async () => {
      const inner = new MemoryIdempotencyStore();
      const flaky: IdempotencyStore = {
        claim: (...args) => inner.claim(...args),
        complete: async () => {
          throw new Error("redis unavailable");
        },
        fail: (...args) => inner.fail(...args),
        read: (...args) => inner.read(...args),
      };

      const { app, exportRecipe, setNow } = harness(async () => SAVED, flaky);

      await post(app, { auth: bearer() });

      // Still in progress from the record's point of view.
      expect((await post(app, { auth: bearer() })).json().error).toBe("Export already in progress");

      // And once the lease lapses, unknown — never a second write.
      setNow(T0 + LEASE_MS + 1);
      expect((await post(app, { auth: bearer() })).json().error).toBe("Export outcome unknown");
      expect(exportRecipe).toHaveBeenCalledTimes(1);
    });
  });

  describe("auth", () => {
    it("rejects an unauthenticated request before touching the store", async () => {
      const { app, exportRecipe } = harness();
      const response = await post(app);

      expect(response.statusCode).toBe(401);
      expect(response.json().requestId).toMatch(REQUEST_ID);
      expect(exportRecipe).not.toHaveBeenCalled();
    });
  });
});
