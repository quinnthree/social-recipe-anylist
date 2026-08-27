import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { MemoryClientCredentialStore } from "../../src/client/memory-store.js";
import type { ClientCredentialStore } from "../../src/client/store.js";
import { mintCredential } from "../../src/client/token.js";
import { buildServer } from "../../src/http/server.js";
import { MemoryIdempotencyStore } from "../../src/idempotency/memory-store.js";
import { storeKey, type IdempotencyStore } from "../../src/idempotency/store.js";
import { MemoryRateLimitStore } from "../../src/ratelimit/memory-store.js";
import { idempotencyKeyFor } from "../../src/test-support/idempotency-keys.js";
import { validRecipe } from "../../src/test-support/fixtures.js";

/**
 * Idempotency identity at the route boundary (M6C-1).
 *
 * ## Why installation identity must not affect matching
 *
 * M5E gives the native client a bounded 401 recovery: when the server rejects
 * its installation credential, it discards it, registers a **replacement**, and
 * retries the original request once — deliberately preserving the same
 * `Idempotency-Key`, because the retry is the same logical export
 * (`HTTPRecipeAPIClient.performAuthenticated`).
 *
 * Registration mints a fresh random `clientId` every time and the backend keeps
 * no lineage between the old credential and its replacement — there is no
 * stable installation identifier anywhere in the system. So a `clientId` in the
 * storage namespace or in the fingerprint would give the retry a *different*
 * identity, the record would read as unseen, and a second `createRecipe` would
 * run after the first attempt may already have written. `deleteRecipe()`
 * returns success without deleting (ADR-021), so that duplicate would be
 * permanent.
 *
 * These tests exist to make that invariance explicit and enforced, rather than
 * an accident of the current key construction that a later change could undo.
 */

const API_KEY = "test-api-key-2f8c1d";
const ROUTE = "exports-anylist";

interface Harness {
  app: FastifyInstance;
  store: ClientCredentialStore;
  idempotency: IdempotencyStore;
  exportRecipe: ReturnType<typeof vi.fn>;
}

function harness(
  options: { exportRecipe?: ReturnType<typeof vi.fn>; now?: () => number; leaseMs?: number } = {},
): Harness {
  const store = new MemoryClientCredentialStore();
  const idempotency = new MemoryIdempotencyStore();
  const exportRecipe =
    options.exportRecipe ??
    vi.fn(async () => ({ name: validRecipe.title, identifier: "anylist-recipe-id" }));

  const app = buildServer({
    apiKey: API_KEY,
    clientStore: store,
    rateLimitStore: new MemoryRateLimitStore(),
    idempotencyStore: idempotency,
    exportRecipe: exportRecipe as never,
    extractRecipe: (async () => validRecipe) as never,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
  });

  return { app, store, idempotency, exportRecipe };
}

/** Registers a credential directly, the way a replacement registration would. */
async function newInstallation(store: ClientCredentialStore): Promise<string> {
  const credential = mintCredential();

  await store.create({
    clientId: credential.clientId,
    secretHash: credential.secretHash,
    createdAt: Date.now(),
  });

  return credential.token;
}

function exportRequest(app: FastifyInstance, token: string, key: string, recipe = validRecipe) {
  return app.inject({
    method: "POST",
    url: "/api/exports/anylist",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "idempotency-key": idempotencyKeyFor(key),
    },
    payload: { schemaVersion: 1, recipe } as never,
  });
}

describe("a rotated installation credential reaches the same idempotency record", () => {
  it("replays a COMPLETED export to a different clientId", async () => {
    const { app, store, exportRecipe } = harness();
    const first = await newInstallation(store);
    const second = await newInstallation(store);

    expect(first).not.toBe(second);

    const original = await exportRequest(app, first, "rotation-completed");
    expect(original.statusCode).toBe(200);
    expect(original.json().idempotent).toBe(false);

    // The M5E retry: same key, same recipe, replacement credential.
    const retry = await exportRequest(app, second, "rotation-completed");

    expect(retry.statusCode).toBe(200);
    expect(retry.json().idempotent).toBe(true);
    expect(retry.json().saved).toEqual(original.json().saved);
    expect(retry.json().originalRequestId).toBe(original.json().requestId);
    // The whole point: the replacement did not cause a second AnyList write.
    expect(exportRecipe).toHaveBeenCalledTimes(1);
  });

  it("reports IN_PROGRESS to a different clientId rather than starting again", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const exportRecipe = vi.fn(async () => {
      entered();
      await held;
      return { name: validRecipe.title, identifier: "anylist-recipe-id" };
    });

    const { app, store } = harness({ exportRecipe });
    const first = await newInstallation(store);
    const second = await newInstallation(store);

    const inFlight = exportRequest(app, first, "rotation-in-progress");
    await started;

    const retry = await exportRequest(app, second, "rotation-in-progress");

    expect(retry.statusCode).toBe(409);
    expect(retry.json().error).toBe("Export already in progress");
    expect(exportRecipe).toHaveBeenCalledTimes(1);

    release();
    await inFlight;
  });

  it("reports AMBIGUOUS to a different clientId rather than retrying", async () => {
    const exportRecipe = vi.fn(async () => {
      throw new Error("outcome unknown");
    });

    const { app, store } = harness({ exportRecipe });
    const first = await newInstallation(store);
    const second = await newInstallation(store);

    const original = await exportRequest(app, first, "rotation-ambiguous");
    expect(original.statusCode).toBe(500);

    const retry = await exportRequest(app, second, "rotation-ambiguous");

    expect(retry.statusCode).toBe(409);
    expect(retry.json().error).toBe("Export outcome unknown");
    // An ambiguous outcome is never retried, whoever is asking.
    expect(exportRecipe).toHaveBeenCalledTimes(1);
  });

  it("lets a different clientId re-claim a FAILED_SAFE record", async () => {
    let attempt = 0;
    const exportRecipe = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        const { ExportError } = await import("../../src/app/export-service.js");
        throw new ExportError("login failed", "FAILED_SAFE", "login_failed");
      }
      return { name: validRecipe.title, identifier: "anylist-recipe-id" };
    });

    const { app, store } = harness({ exportRecipe });
    const first = await newInstallation(store);
    const second = await newInstallation(store);

    expect((await exportRequest(app, first, "rotation-failed-safe")).statusCode).toBe(500);

    // FAILED_SAFE carries positive evidence that no write happened, so the
    // replacement credential may genuinely retry — and must land on the same
    // record rather than creating a parallel one.
    const retry = await exportRequest(app, second, "rotation-failed-safe");

    expect(retry.statusCode).toBe(200);
    expect(retry.json().idempotent).toBe(false);
    expect(exportRecipe).toHaveBeenCalledTimes(2);
  });

  it("keys the record on the route and the raw key alone", async () => {
    const { app, store, idempotency } = harness();
    const token = await newInstallation(store);
    const key = idempotencyKeyFor("rotation-shape");

    await exportRequest(app, token, "rotation-shape");

    // Derived without any identity input. If this ever needs a clientId to
    // compute, the invariance above has been lost.
    const record = await idempotency.read(storeKey(ROUTE, key));

    expect(record?.state).toBe("COMPLETED");
  });

  it("still separates two genuinely different keys", async () => {
    const { app, store, exportRecipe } = harness();
    const token = await newInstallation(store);

    await exportRequest(app, token, "distinct-a");
    await exportRequest(app, token, "distinct-b");

    // Invariance to identity must not become indifference to the key.
    expect(exportRecipe).toHaveBeenCalledTimes(2);
  });

  it("still conflicts when the same key carries a different recipe", async () => {
    const { app, store } = harness();
    const first = await newInstallation(store);
    const second = await newInstallation(store);

    await exportRequest(app, first, "rotation-conflict");
    const retry = await exportRequest(app, second, "rotation-conflict", {
      ...validRecipe,
      title: "A different recipe",
    });

    expect(retry.statusCode).toBe(409);
    expect(retry.json().error).toBe("Idempotency key conflict");
  });
});

describe("a malformed key is refused before the store is touched", () => {
  it.each([
    ["an opaque string", "client-key-1"],
    ["whitespace only", "   "],
    ["a UUID with surrounding whitespace", " 7c9e6679-7425-40de-944b-e07fc1f90ae7 "],
    ["129 characters", "x".repeat(129)],
  ])("rejects %s without claiming or exporting", async (_label, rawKey) => {
    const { app, store, idempotency, exportRecipe } = harness();
    const token = await newInstallation(store);
    const claim = vi.spyOn(idempotency, "claim");

    const response = await app.inject({
      method: "POST",
      url: "/api/exports/anylist",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "idempotency-key": rawKey,
      },
      payload: { schemaVersion: 1, recipe: validRecipe } as never,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("Invalid idempotency key");
    expect(claim).not.toHaveBeenCalled();
    expect(exportRecipe).not.toHaveBeenCalled();
  });
});
