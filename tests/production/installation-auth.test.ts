import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { MemoryClientCredentialStore } from "../../src/client/memory-store.js";
import type { ClientCredentialStore } from "../../src/client/store.js";
import { buildToken, mintClientId, mintCredential, mintSecret } from "../../src/client/token.js";
import { buildServer } from "../../src/http/server.js";
import { TEST_URL, validRecipe } from "../../src/test-support/fixtures.js";

/**
 * Installation credentials at the route boundary (ADR-026).
 *
 * The unit-level resolver tests live in `src/http/principal.test.ts`. These
 * assert the part a client actually observes: which requests get in, which are
 * refused, and that nothing about the existing private-key path changed.
 */

const API_KEY = "test-api-key-2f8c1d";

interface Harness {
  app: FastifyInstance;
  store: ClientCredentialStore;
  logs: () => string[];
}

function harness(store: ClientCredentialStore | undefined = new MemoryClientCredentialStore()): Harness {
  const lines: string[] = [];

  const app = buildServer({
    apiKey: API_KEY,
    clientStore: store,
    extractRecipe: (async () => validRecipe) as never,
    logger: true,
    logDestination: {
      write(chunk: string) {
        lines.push(chunk);
      },
    },
  });

  return {
    app,
    store: store ?? new MemoryClientCredentialStore(),
    logs: () => lines,
  };
}

async function credentialIn(store: ClientCredentialStore, now: number = Date.now()) {
  const credential = mintCredential();

  await store.create({
    clientId: credential.clientId,
    secretHash: credential.secretHash,
    createdAt: now,
  });

  return credential;
}

function imports(app: FastifyInstance, auth: string | undefined) {
  return app.inject({
    method: "POST",
    url: "/api/imports",
    headers: {
      "content-type": "application/json",
      ...(auth === undefined ? {} : { authorization: auth }),
    },
    payload: { schemaVersion: 1, url: TEST_URL },
  });
}

function telemetryOf(lines: string[]): Record<string, unknown> | undefined {
  return lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((entry) => entry["event"] === "import.telemetry");
}

describe("the private key still works", () => {
  it("authenticates a protected route", async () => {
    const { app } = harness();

    expect((await imports(app, `Bearer ${API_KEY}`)).statusCode).toBe(200);
  });

  it("works with no credential store configured at all", async () => {
    // Nothing about internal access may depend on consumer infrastructure.
    const { app } = harness(undefined);

    expect((await imports(app, `Bearer ${API_KEY}`)).statusCode).toBe(200);
  });

  it("reports itself as the internal principal, with no clientId", async () => {
    const { app, logs } = harness();

    await imports(app, `Bearer ${API_KEY}`);
    const telemetry = telemetryOf(logs());

    expect(telemetry?.["principalKind"]).toBe("internal");
    expect(telemetry?.["clientId"]).toBeNull();
  });
});

describe("an installation credential", () => {
  it("authenticates a protected route", async () => {
    const { app, store } = harness();
    const credential = await credentialIn(store);

    expect((await imports(app, `Bearer ${credential.token}`)).statusCode).toBe(200);
  });

  it("reports its clientId in telemetry, and nothing else about the credential", async () => {
    const { app, store, logs } = harness();
    const credential = await credentialIn(store);

    await imports(app, `Bearer ${credential.token}`);
    const telemetry = telemetryOf(logs());

    expect(telemetry?.["principalKind"]).toBe("installation");
    expect(telemetry?.["clientId"]).toBe(credential.clientId);

    const written = logs().join("");
    expect(written).not.toContain(credential.token);
    expect(written).not.toContain(credential.secretHash);
  });

  it("is recorded as used", async () => {
    const { app, store } = harness();
    const credential = await credentialIn(store);

    await imports(app, `Bearer ${credential.token}`);

    expect((await store.read(credential.clientId))?.lastSeenAt).not.toBeNull();
  });

  it.each([
    ["a malformed token", () => "sr1_nonsense"],
    ["an unknown clientId", () => buildToken(mintClientId(), mintSecret())],
  ])("is refused for %s", async (_label, token) => {
    const { app } = harness();
    const response = await imports(app, `Bearer ${token()}`);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ success: false, error: "Unauthorized" });
  });

  it("is refused when the secret is wrong", async () => {
    const { app, store } = harness();
    const credential = await credentialIn(store);
    const forged = buildToken(credential.clientId, mintSecret());

    expect((await imports(app, `Bearer ${forged}`)).statusCode).toBe(401);
  });

  it("is refused once revoked", async () => {
    const { app, store } = harness();
    const credential = await credentialIn(store);

    expect((await imports(app, `Bearer ${credential.token}`)).statusCode).toBe(200);

    await store.revoke(credential.clientId, Date.now());

    expect((await imports(app, `Bearer ${credential.token}`)).statusCode).toBe(401);
  });

  it("is refused where the deployment offers no consumer authentication", async () => {
    const configured = new MemoryClientCredentialStore();
    const credential = await credentialIn(configured);
    const { app } = harness(undefined);

    expect((await imports(app, `Bearer ${credential.token}`)).statusCode).toBe(401);
  });

  it("leaves no principal in telemetry when it is refused", async () => {
    const { app, logs } = harness();

    await imports(app, `Bearer ${buildToken(mintClientId(), mintSecret())}`);
    const telemetry = telemetryOf(logs());

    // A rejected caller must not get to plant a clientId in our telemetry.
    expect(telemetry?.["principalKind"]).toBeNull();
    expect(telemetry?.["clientId"]).toBeNull();
    expect(telemetry?.["failureKind"]).toBe("unauthorized");
    expect(telemetry?.["failureStage"]).toBe("auth");
  });
});

describe("an unavailable credential store", () => {
  const broken: ClientCredentialStore = {
    create: () => Promise.reject(new Error("upstash: ECONNRESET")),
    read: () => Promise.reject(new Error("upstash: ECONNRESET")),
    touch: () => Promise.reject(new Error("upstash: ECONNRESET")),
    revoke: () => Promise.reject(new Error("upstash: ECONNRESET")),
    deleteIfUnused: () => Promise.reject(new Error("upstash: ECONNRESET")),
  };

  it("fails closed, and does not report the credential as bad", async () => {
    const { app } = harness(broken);
    const credential = mintCredential();

    const response = await imports(app, `Bearer ${credential.token}`);

    // Not 401: the iOS client treats that as "discard the credential and
    // register again", so an outage answered with 401 would destroy every
    // working credential and stampede registration at the same time.
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ success: false, error: "Recipe import failed" });
  });

  it("names the operation on the export route", async () => {
    const { app } = harness(broken);
    const credential = mintCredential();

    const response = await app.inject({
      method: "POST",
      url: "/api/exports/anylist",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credential.token}`,
        "idempotency-key": "key-1",
      },
      payload: { schemaVersion: 1, recipe: validRecipe },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: "Recipe export failed" });
  });

  it("still admits the internal key", async () => {
    const { app } = harness(broken);

    expect((await imports(app, `Bearer ${API_KEY}`)).statusCode).toBe(200);
  });

  it("leaks no store detail", async () => {
    const { app, logs } = harness(broken);
    const response = await imports(app, `Bearer ${mintCredential().token}`);

    expect(response.body).not.toContain("ECONNRESET");
    expect(response.body).not.toContain("upstash");
    expect(logs().join("")).not.toContain("ECONNRESET");
  });
});

describe("nothing else about the boundary moved", () => {
  it("keeps /health public", async () => {
    const { app } = harness();

    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });

  it("keeps /health working without a credential store", async () => {
    const { app } = harness(undefined);

    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });

  it("still rejects a missing bearer", async () => {
    const { app } = harness();

    expect((await imports(app, undefined)).statusCode).toBe(401);
  });

  it("still answers 404 on an unmatched route rather than 401", async () => {
    const { app } = harness();
    const response = await app.inject({ method: "GET", url: "/nope" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "Not found" });
  });

  it("still carries X-Request-Id on a 401", async () => {
    const { app } = harness();
    const response = await imports(app, "Bearer nope");

    expect(response.headers["x-request-id"]).toBeTruthy();
    expect(response.json()).toHaveProperty("requestId");
  });

  it("still emits exactly one telemetry event for a rejected request", async () => {
    const { app, logs } = harness();

    await imports(app, "Bearer nope");

    const events = logs()
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry["event"] === "import.telemetry");

    expect(events).toHaveLength(1);
  });

  it("has no registration route", async () => {
    const { app } = harness();

    // B3 mounts this. Until then it must not exist, publicly or otherwise.
    const response = await app.inject({
      method: "POST",
      url: "/api/client/register",
      headers: { "content-type": "application/json" },
      payload: { schemaVersion: 1 },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "Not found" });
  });
});
