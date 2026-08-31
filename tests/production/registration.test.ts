import type { FastifyInstance, InjectOptions } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { MemoryClientCredentialStore } from "../../src/client/memory-store.js";
import type { ClientCredentialStore } from "../../src/client/store.js";
import { parseToken, TOKEN_PREFIX } from "../../src/client/token.js";
import { DEFAULT_LIMITS, type LimitPolicy } from "../../src/http/limits.js";
import { buildServer } from "../../src/http/server.js";
import { MemoryRateLimitStore } from "../../src/ratelimit/memory-store.js";
import type { RateLimitStore } from "../../src/ratelimit/store.js";
import { TEST_URL, validRecipe } from "../../src/test-support/fixtures.js";

/**
 * The public credential mint (ADR-026, ADR-027).
 *
 * This is the only route that hands out a secret and the only one besides
 * `/health` that requires none, so the cases below lean on the two properties
 * that keep it safe: limits are charged before anything is minted, and every
 * infrastructure failure refuses rather than issues.
 */

const API_KEY = "test-api-key-2f8c1d";
const IP = "203.0.113.9";

interface Harness {
  app: FastifyInstance;
  clientStore: ClientCredentialStore;
  logs: () => string;
}

function harness(
  options: {
    clientStore?: ClientCredentialStore | undefined;
    rateLimitStore?: RateLimitStore | undefined;
    limits?: Partial<LimitPolicy>;
    now?: () => number;
  } = {},
): Harness {
  let output = "";
  const clientStore =
    options.clientStore === undefined && !("clientStore" in options)
      ? new MemoryClientCredentialStore()
      : options.clientStore;

  const app = buildServer({
    apiKey: API_KEY,
    clientStore,
    rateLimitStore:
      options.rateLimitStore === undefined && !("rateLimitStore" in options)
        ? new MemoryRateLimitStore()
        : options.rateLimitStore,
    limits: { ...DEFAULT_LIMITS, ...options.limits },
    ipStrategy: "forwarded",
    extractRecipe: (async () => validRecipe) as never,
    exportRecipe: (async () => ({ name: validRecipe.title, identifier: "id-1" })) as never,
    ...(options.now === undefined ? {} : { now: options.now }),
    logger: true,
    logDestination: {
      write(chunk: string) {
        output += chunk;
      },
    },
  });

  return {
    app,
    clientStore: clientStore ?? new MemoryClientCredentialStore(),
    logs: () => output,
  };
}

function register(app: FastifyInstance, ip: string = IP, payload: unknown = { schemaVersion: 1 }) {
  const options: InjectOptions = {
    method: "POST",
    url: "/api/client/register",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    payload: payload as never,
  };

  return app.inject(options);
}

describe("issuing a credential", () => {
  it("needs no credential of its own", async () => {
    const { app } = harness();
    const response = await register(app);

    expect(response.statusCode).toBe(200);
  });

  it("returns a usable token and a public id", async () => {
    const { app } = harness();
    const body = (await register(app)).json() as {
      success: boolean;
      schemaVersion: number;
      requestId: string;
      client: { id: string; token: string };
    };

    expect(body.success).toBe(true);
    expect(body.schemaVersion).toBe(1);
    expect(body.requestId).toMatch(/^req_/);
    expect(body.client.token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(parseToken(body.client.token)?.clientId).toBe(body.client.id);
  });

  it("stores a digest and never the secret", async () => {
    const { app, clientStore } = harness();
    const body = (await register(app)).json() as { client: { id: string; token: string } };

    const record = await clientStore.read(body.client.id);
    const secret = parseToken(body.client.token)?.secret;

    expect(record?.status).toBe("active");
    expect(record?.lastSeenAt).toBeNull();
    expect(JSON.stringify(record)).not.toContain(secret);
  });

  it("issues a credential that immediately authenticates a protected route", async () => {
    const { app } = harness();
    const body = (await register(app)).json() as { client: { token: string } };

    const response = await app.inject({
      method: "POST",
      url: "/api/imports",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${body.client.token}`,
      },
      payload: { schemaVersion: 1, url: TEST_URL } as never,
    });

    expect(response.statusCode).toBe(200);
  });

  it("mints a distinct credential every time", async () => {
    const { app } = harness();
    const ids = new Set<string>();

    for (let i = 0; i < 5; i += 1) {
      const body = (await register(app)).json() as { client: { id: string } };
      ids.add(body.client.id);
    }

    expect(ids.size).toBe(5);
  });

  it("never overwrites an existing record when an id collides", async () => {
    const inner = new MemoryClientCredentialStore();
    let firstCall = true;
    const colliding: ClientCredentialStore = {
      ...inner,
      create: async (record) => {
        if (firstCall) {
          firstCall = false;
          return "exists";
        }
        return inner.create(record);
      },
      read: (id) => inner.read(id),
      touch: (id, now, refresh) => inner.touch(id, now, refresh),
      revoke: (id, now) => inner.revoke(id, now),
      deleteIfUnused: (id, now, older) => inner.deleteIfUnused(id, now, older),
    };

    const { app } = harness({ clientStore: colliding });
    const response = await register(app);

    // Mints a fresh id rather than replacing whatever is already there.
    expect(response.statusCode).toBe(200);
  });

  it("never logs the token or the secret", async () => {
    const { app, logs } = harness();
    const body = (await register(app)).json() as { client: { id: string; token: string } };

    expect(logs()).not.toContain(body.client.token);
    expect(logs()).not.toContain(parseToken(body.client.token)?.secret);
    expect(logs()).not.toContain("sr1_");
    // The public id is the operational identifier, and is expected here.
    expect(logs()).toContain(body.client.id);
  });
});

describe("rejecting a malformed registration", () => {
  it.each([
    ["an unknown key", { schemaVersion: 1, installationId: "nope" }],
    ["a missing version", {}],
    ["an array", []],
    ["a client-supplied secret", { schemaVersion: 1, token: "sr1_x" }],
  ])("refuses %s", async (_label, payload) => {
    const { app } = harness();
    const response = await register(app, IP, payload);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "Invalid request body" });
  });

  it("names an unsupported version distinctly", async () => {
    const { app } = harness();
    const response = await register(app, IP, { schemaVersion: 7 });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "Unsupported schema version" });
  });
});

describe("registration limits", () => {
  it("allows the hourly allowance and refuses the next", async () => {
    const { app } = harness();

    for (let i = 0; i < DEFAULT_LIMITS.registrationPerIpHour; i += 1) {
      expect((await register(app)).statusCode).toBe(200);
    }

    const refused = await register(app);
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ error: "Too many requests" });
    expect(refused.json()).toHaveProperty("requestId");
    expect(refused.headers["x-request-id"]).toBeTruthy();
  });

  it("lets the hourly window roll over", async () => {
    let clock = Date.now();
    const { app } = harness({ now: () => clock });

    for (let i = 0; i < DEFAULT_LIMITS.registrationPerIpHour; i += 1) {
      await register(app);
    }
    expect((await register(app)).statusCode).toBe(429);

    clock += 60 * 60 * 1000;
    expect((await register(app)).statusCode).toBe(200);
  });

  /**
   * A fixed start, because this test simulates four hours and the daily bucket
   * is aligned to UTC midnight.
   *
   * `Date.now()` here was a real defect. Rate-limit windows are fixed-width
   * epoch buckets — `Math.floor(now / windowMs)` in `src/ratelimit/store.ts` —
   * so the daily bucket turns over at 00:00 UTC. Seeding from the wall clock
   * meant that any run starting between 20:00 and 24:00 UTC pushed the
   * simulated `+4h` across midnight, the daily allowance reset mid-test, and
   * the final registration returned 200 instead of 429. The limiter was right
   * every time; the test simply asked a different question depending on when it
   * ran, and failed for four hours out of every twenty-four.
   *
   * 09:00 UTC leaves nine hours of headroom behind and eleven ahead, so the
   * whole simulated span stays inside one UTC day whatever the machine's
   * timezone or the time of day.
   *
   * The hourly-rollover test above is deliberately left alone: a day boundary
   * crossing there would only reset a bucket it already expects to be reset, so
   * its outcome never depended on the wall clock.
   */
  const FIXED_START_UTC = Date.UTC(2026, 0, 15, 9, 0, 0);

  /** The span the test simulates: four hourly rollovers, then one more request. */
  const SIMULATED_SPAN_MS = 4 * 60 * 60 * 1000;

  it("keeps its fixed start clear of the UTC daily boundary", () => {
    // Guards the constant rather than the limiter. If someone moves the start
    // time to within four hours of midnight, this fails immediately instead of
    // the suite going red once a day for reasons nobody can reproduce locally.
    const start = new Date(FIXED_START_UTC);
    const end = new Date(FIXED_START_UTC + SIMULATED_SPAN_MS);

    expect(start.getUTCDate()).toBe(end.getUTCDate());
    expect(start.getUTCHours()).toBeGreaterThanOrEqual(4);
    expect(start.getUTCHours() + SIMULATED_SPAN_MS / 3_600_000).toBeLessThan(24);
  });

  it("still holds the daily allowance across rolled-over hours", async () => {
    let clock = FIXED_START_UTC;
    const { app } = harness({ now: () => clock });
    let issued = 0;

    // Four full hours at the hourly allowance reaches the daily one.
    for (let hour = 0; hour < 4; hour += 1) {
      for (let i = 0; i < DEFAULT_LIMITS.registrationPerIpHour; i += 1) {
        if ((await register(app)).statusCode === 200) issued += 1;
      }
      clock += 60 * 60 * 1000;
    }

    expect(issued).toBe(DEFAULT_LIMITS.registrationPerIpDay);
    expect((await register(app)).statusCode).toBe(429);
  });

  it("lets the daily allowance reset when the simulated hours cross UTC midnight", async () => {
    // The demonstration. This is the exact scenario the wall-clock seed used to
    // wander into: starting at 22:00 UTC, the four simulated hours straddle
    // midnight, so the last two hours are charged to the next day's bucket and
    // the twenty-first registration is allowed.
    //
    // Nothing is wrong with that — it is the daily limiter working as designed.
    // What was wrong was a test whose expectation silently depended on which
    // side of the boundary the machine happened to be on.
    let clock = Date.UTC(2026, 0, 15, 22, 0, 0);
    const { app } = harness({ now: () => clock });
    let issued = 0;

    for (let hour = 0; hour < 4; hour += 1) {
      for (let i = 0; i < DEFAULT_LIMITS.registrationPerIpHour; i += 1) {
        if ((await register(app)).statusCode === 200) issued += 1;
      }
      clock += 60 * 60 * 1000;
    }

    expect(issued).toBe(DEFAULT_LIMITS.registrationPerIpDay);
    // 200 rather than the 429 above, and for a reason a reader can name.
    expect((await register(app)).statusCode).toBe(200);
  });

  it("gives different addresses independent buckets", async () => {
    const { app } = harness();

    for (let i = 0; i < DEFAULT_LIMITS.registrationPerIpHour; i += 1) {
      await register(app, "203.0.113.9");
    }

    expect((await register(app, "203.0.113.9")).statusCode).toBe(429);
    expect((await register(app, "198.51.100.4")).statusCode).toBe(200);
  });

  it("enforces the global ceiling regardless of address", async () => {
    const { app } = harness({ limits: { registrationGlobalMinute: 3 } });

    for (let i = 0; i < 3; i += 1) {
      expect((await register(app, `198.51.100.${i}`)).statusCode).toBe(200);
    }

    // A fresh address, and still refused: the ceiling that does not depend on
    // reading a forwarded header correctly.
    expect((await register(app, "198.51.100.200")).statusCode).toBe(429);
  });

  it("cannot be evaded by prepending an invented address", async () => {
    const { app } = harness();

    for (let i = 0; i < DEFAULT_LIMITS.registrationPerIpHour; i += 1) {
      await register(app, IP);
    }

    // The platform appends the real address, so an invented entry sits to the
    // left of it and changes nothing.
    const evasion = await app.inject({
      method: "POST",
      url: "/api/client/register",
      headers: { "content-type": "application/json", "x-forwarded-for": `9.9.9.9, ${IP}` },
      payload: { schemaVersion: 1 } as never,
    });

    expect(evasion.statusCode).toBe(429);
  });

  it("charges nothing when it refuses", async () => {
    const { app, clientStore } = harness({ limits: { registrationPerIpHour: 1 } });

    const issued = (await register(app)).json() as { client: { id: string } };
    expect((await register(app)).statusCode).toBe(429);

    // Only the permitted request minted anything: a denied registration must
    // not leave an orphan credential behind.
    expect(await clientStore.read(issued.client.id)).not.toBeNull();
  });

  it("mints nothing at all when the limit refuses", async () => {
    const created = vi.fn();
    const store = new MemoryClientCredentialStore();
    const watched: ClientCredentialStore = {
      ...store,
      create: (record) => {
        created();
        return store.create(record);
      },
      read: (id) => store.read(id),
      touch: (id, now, refresh) => store.touch(id, now, refresh),
      revoke: (id, now) => store.revoke(id, now),
      deleteIfUnused: (id, now, older) => store.deleteIfUnused(id, now, older),
    };

    const { app } = harness({ clientStore: watched, limits: { registrationPerIpHour: 1 } });

    await register(app);
    await register(app);

    expect(created).toHaveBeenCalledTimes(1);
  });
});

describe("registration fails closed", () => {
  const broken = <T>(): T =>
    ({
      create: () => Promise.reject(new Error("upstash: ECONNRESET")),
      read: () => Promise.reject(new Error("upstash: ECONNRESET")),
      touch: () => Promise.reject(new Error("upstash: ECONNRESET")),
      revoke: () => Promise.reject(new Error("upstash: ECONNRESET")),
      deleteIfUnused: () => Promise.reject(new Error("upstash: ECONNRESET")),
      consume: () => Promise.reject(new Error("upstash: ECONNRESET")),
    }) as T;

  it("refuses when the credential store is unavailable", async () => {
    const { app } = harness({ clientStore: broken<ClientCredentialStore>() });
    const response = await register(app);

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: "Registration failed" });
  });

  it("refuses when the counter store is unavailable", async () => {
    // Not "unrestricted registration": infrastructure that cannot say whether
    // issuance is allowed is not permission to issue.
    const { app } = harness({ rateLimitStore: broken<RateLimitStore>() });
    const response = await register(app);

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: "Registration failed" });
  });

  it("refuses when this deployment has no consumer stores at all", async () => {
    const { app } = harness({ clientStore: undefined, rateLimitStore: undefined });

    expect((await register(app)).statusCode).toBe(500);
  });

  it("leaks nothing about the store", async () => {
    const { app, logs } = harness({ clientStore: broken<ClientCredentialStore>() });
    const response = await register(app);

    expect(response.body).not.toContain("ECONNRESET");
    expect(logs()).not.toContain("ECONNRESET");
  });
});
