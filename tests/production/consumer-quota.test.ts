import type { FastifyInstance } from "fastify";
import { idempotencyKeyFor } from "../../src/test-support/idempotency-keys.js";
import { describe, expect, it, vi } from "vitest";

import { MemoryClientCredentialStore } from "../../src/client/memory-store.js";
import { mintCredential } from "../../src/client/token.js";
import { DEFAULT_LIMITS } from "../../src/http/limits.js";
import { buildServer } from "../../src/http/server.js";
import { MemoryRateLimitStore } from "../../src/ratelimit/memory-store.js";
import type { RateLimitStore } from "../../src/ratelimit/store.js";
import { exportBody, TEST_URL, validRecipe } from "../../src/test-support/fixtures.js";

/**
 * Per-installation quotas (ADR-027).
 *
 * Extraction is the only operation that spends money with a third party on an
 * anonymous caller's behalf, so the import quota is the one that matters — and
 * the case that matters most is that a refused request never reaches it.
 */

const API_KEY = "test-api-key-2f8c1d";

async function harness(
  options: { rateLimitStore?: RateLimitStore; extract?: () => Promise<unknown> } = {},
) {
  const clientStore = new MemoryClientCredentialStore();
  const credential = mintCredential();
  await clientStore.create({
    clientId: credential.clientId,
    secretHash: credential.secretHash,
    createdAt: Date.now(),
  });

  const extract = vi.fn(options.extract ?? (async () => validRecipe));
  const exportRecipe = vi.fn(async () => ({ name: validRecipe.title, identifier: "id-1" }));

  const app = buildServer({
    apiKey: API_KEY,
    clientStore,
    rateLimitStore: options.rateLimitStore ?? new MemoryRateLimitStore(),
    extractRecipe: extract as never,
    exportRecipe: exportRecipe as never,
  });

  return { app, clientStore, credential, extract, exportRecipe };
}

function imports(app: FastifyInstance, auth: string) {
  return app.inject({
    method: "POST",
    url: "/api/imports",
    headers: { "content-type": "application/json", authorization: auth },
    payload: { schemaVersion: 1, url: TEST_URL } as never,
  });
}

function exports(app: FastifyInstance, auth: string, key: string) {
  return app.inject({
    method: "POST",
    url: "/api/exports/anylist",
    headers: {
      "content-type": "application/json",
      authorization: auth,
      "idempotency-key": idempotencyKeyFor(key),
    },
    payload: exportBody() as never,
  });
}

describe("the import quota", () => {
  it("allows the daily allowance and refuses the next", async () => {
    const { app, credential } = await harness();
    const auth = `Bearer ${credential.token}`;

    for (let i = 0; i < DEFAULT_LIMITS.importsPerClientDay; i += 1) {
      expect((await imports(app, auth)).statusCode).toBe(200);
    }

    const refused = await imports(app, auth);
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ error: "Too many requests" });
    expect(refused.json()).toHaveProperty("requestId");
    expect(refused.headers["x-request-id"]).toBeTruthy();
  });

  it("stops a refused request before any extraction happens", async () => {
    const { app, credential, extract } = await harness();
    const auth = `Bearer ${credential.token}`;

    for (let i = 0; i < DEFAULT_LIMITS.importsPerClientDay + 3; i += 1) {
      await imports(app, auth);
    }

    // The whole point: a quota that only bit after the model call would be
    // protecting nothing.
    expect(extract).toHaveBeenCalledTimes(DEFAULT_LIMITS.importsPerClientDay);
  });

  it("keeps installations independent", async () => {
    const { app, clientStore, credential } = await harness();
    const other = mintCredential();
    await clientStore.create({
      clientId: other.clientId,
      secretHash: other.secretHash,
      createdAt: Date.now(),
    });

    for (let i = 0; i < DEFAULT_LIMITS.importsPerClientDay; i += 1) {
      await imports(app, `Bearer ${credential.token}`);
    }

    expect((await imports(app, `Bearer ${credential.token}`)).statusCode).toBe(429);
    expect((await imports(app, `Bearer ${other.token}`)).statusCode).toBe(200);
  });
});

describe("the export quota", () => {
  it("allows the daily allowance and refuses the next", async () => {
    const { app, credential } = await harness();
    const auth = `Bearer ${credential.token}`;

    for (let i = 0; i < DEFAULT_LIMITS.exportsPerClientDay; i += 1) {
      expect((await exports(app, auth, `key-${i}`)).statusCode).toBe(200);
    }

    expect((await exports(app, auth, "key-over")).statusCode).toBe(429);
  });

  it("charges a replay too, so repeated calls are not free", async () => {
    const { app, credential, exportRecipe } = await harness();
    const auth = `Bearer ${credential.token}`;

    const first = await exports(app, auth, "same-key");
    const replay = await exports(app, auth, "same-key");

    expect(first.json()).toMatchObject({ idempotent: false });
    expect(replay.json()).toMatchObject({ idempotent: true });
    // Exactly one AnyList write, two metered requests: quota counts requests
    // served, idempotency counts writes performed.
    expect(exportRecipe).toHaveBeenCalledTimes(1);

    for (let i = 0; i < DEFAULT_LIMITS.exportsPerClientDay - 2; i += 1) {
      await exports(app, auth, `filler-${i}`);
    }

    expect((await exports(app, auth, "same-key")).statusCode).toBe(429);
  });

  it("keeps installations independent", async () => {
    const { app, clientStore, credential } = await harness();
    const other = mintCredential();
    await clientStore.create({
      clientId: other.clientId,
      secretHash: other.secretHash,
      createdAt: Date.now(),
    });

    for (let i = 0; i < DEFAULT_LIMITS.exportsPerClientDay; i += 1) {
      await exports(app, `Bearer ${credential.token}`, `key-${i}`);
    }

    expect((await exports(app, `Bearer ${credential.token}`, "over")).statusCode).toBe(429);
    expect((await exports(app, `Bearer ${other.token}`, "fresh")).statusCode).toBe(200);
  });
});

describe("internal traffic", () => {
  it("is not metered on imports", async () => {
    const { app } = await harness();

    for (let i = 0; i < DEFAULT_LIMITS.importsPerClientDay + 5; i += 1) {
      expect((await imports(app, `Bearer ${API_KEY}`)).statusCode).toBe(200);
    }
  });

  it("is not metered on exports", async () => {
    const { app } = await harness();

    for (let i = 0; i < DEFAULT_LIMITS.exportsPerClientDay + 3; i += 1) {
      expect((await exports(app, `Bearer ${API_KEY}`, `key-${i}`)).statusCode).toBe(200);
    }
  });

  it("keeps working when the counter store is broken", async () => {
    // Consumer limits are about anonymous callers; the operator's own key must
    // not be taken down by infrastructure it never touches.
    const broken = { consume: () => Promise.reject(new Error("upstash: ECONNRESET")) };
    const { app } = await harness({ rateLimitStore: broken });

    expect((await imports(app, `Bearer ${API_KEY}`)).statusCode).toBe(200);
  });
});

describe("quota accounting", () => {
  it("charges nothing for a request that never authenticated", async () => {
    const { app, credential } = await harness();

    for (let i = 0; i < 50; i += 1) {
      expect((await imports(app, "Bearer nonsense")).statusCode).toBe(401);
    }

    // A rejected caller cannot burn someone else's allowance, or their own.
    expect((await imports(app, `Bearer ${credential.token}`)).statusCode).toBe(200);
  });

  it("fails closed for an installation when the counter store is unavailable", async () => {
    const broken = { consume: () => Promise.reject(new Error("upstash: ECONNRESET")) };
    const { app, credential, extract } = await harness({ rateLimitStore: broken });

    const response = await imports(app, `Bearer ${credential.token}`);

    expect(response.statusCode).toBe(500);
    expect(extract).not.toHaveBeenCalled();
    expect(response.body).not.toContain("ECONNRESET");
  });

  it("names the operation on the export route when it fails closed", async () => {
    const broken = { consume: () => Promise.reject(new Error("upstash: ECONNRESET")) };
    const { app, credential } = await harness({ rateLimitStore: broken });

    const response = await exports(app, `Bearer ${credential.token}`, "key-1");

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: "Recipe export failed" });
  });
});
