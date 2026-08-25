import { describe, expect, it, vi } from "vitest";

import {
  CLEANUP_SCRIPT,
  CREATE_SCRIPT,
  RedisClientCredentialStore,
  REVOKE_SCRIPT,
  TOUCH_SCRIPT,
  type RedisLike,
} from "./redis-store.js";
import { clientKey, UNUSED_CREDENTIAL_TTL_SECONDS } from "./store.js";
import { hashSecret, mintClientId, mintSecret } from "./token.js";

const CLIENT_ID = mintClientId();
const NOW = 1_700_000_000_000;

function stub(reply: unknown): {
  store: RedisClientCredentialStore;
  evaluate: RedisLike["eval"];
  hgetall: RedisLike["hgetall"];
} {
  const evaluate = vi.fn(async () => reply);
  const hgetall = vi.fn(async () => null);

  return { store: new RedisClientCredentialStore({ eval: evaluate, hgetall }), evaluate, hgetall };
}

/**
 * The Lua scripts are what make these operations atomic, and they can only
 * really be executed against Redis — which no automated test here may reach.
 *
 * These assertions pin the specific properties the design turns on, so an edit
 * that quietly breaks one fails here rather than in production. They are not a
 * substitute for running the scripts: that is a live-verification step, and it
 * is recorded as one.
 */
describe("script invariants", () => {
  it("refuses to create over an existing key", () => {
    // Read-then-write in application code would let two concurrent creates for
    // one id both write, silently revoking the loser's credential.
    expect(CREATE_SCRIPT).toContain("EXISTS");
    expect(CREATE_SCRIPT.indexOf("return 'exists'")).toBeLessThan(
      CREATE_SCRIPT.indexOf("'HSET'"),
    );
  });

  it("gives a new credential the unused-window TTL", () => {
    expect(CREATE_SCRIPT).toContain("EXPIRE");
    expect(CREATE_SCRIPT).toContain("unusedTtl");
  });

  it("refuses to touch a revoked record", () => {
    const guard = TOUCH_SCRIPT.indexOf("if status == 'revoked' then return 'revoked' end");

    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(TOUCH_SCRIPT.indexOf("'HSET'"));
  });

  it("makes the record durable on the first successful authentication", () => {
    // PERSIST is what ends the orphan window. Without it a credential in daily
    // use would vanish seven days after registration.
    expect(TOUCH_SCRIPT).toContain("PERSIST");
    expect(TOUCH_SCRIPT.indexOf("PERSIST")).toBeGreaterThan(TOUCH_SCRIPT.indexOf("'HSET'"));
  });

  it("skips a rewrite while lastSeenAt is fresh, but never skips the first", () => {
    expect(TOUCH_SCRIPT).toContain("if lastSeenAt and");
    expect(TOUCH_SCRIPT).toContain("return 'skipped'");
  });

  it("revokes without deleting and without touching retention", () => {
    expect(REVOKE_SCRIPT).toContain("'status', 'revoked'");
    expect(REVOKE_SCRIPT).toContain("revokedAt");
    expect(REVOKE_SCRIPT).not.toContain("DEL");
    expect(REVOKE_SCRIPT).not.toContain("EXPIRE");
    expect(REVOKE_SCRIPT).not.toContain("PERSIST");
  });

  it("checks both cleanup conditions inside the script", () => {
    // Checking in application code would let a credential that authenticates
    // between the read and the delete be removed while in use.
    const lastSeenGuard = CLEANUP_SCRIPT.indexOf("return 'in_use'");
    const ageGuard = CLEANUP_SCRIPT.indexOf("return 'too_recent'");

    expect(lastSeenGuard).toBeGreaterThan(-1);
    expect(ageGuard).toBeGreaterThan(-1);
    expect(Math.max(lastSeenGuard, ageGuard)).toBeLessThan(CLEANUP_SCRIPT.indexOf("'DEL'"));
  });

  it("never writes a raw secret", () => {
    for (const script of [CREATE_SCRIPT, TOUCH_SCRIPT, REVOKE_SCRIPT, CLEANUP_SCRIPT]) {
      expect(script).not.toContain("secret'");
      expect(script).not.toContain("token");
    }

    expect(CREATE_SCRIPT).toContain("secretHash");
  });
});

describe("RedisClientCredentialStore", () => {
  it("creates with the namespaced key and the documented argument order", async () => {
    const { store, evaluate } = stub("created");
    const secretHash = hashSecret(mintSecret());

    expect(await store.create({ clientId: CLIENT_ID, secretHash, createdAt: NOW })).toBe("created");
    expect(evaluate).toHaveBeenCalledWith(
      CREATE_SCRIPT,
      [clientKey(CLIENT_ID)],
      [secretHash, String(NOW), UNUSED_CREDENTIAL_TTL_SECONDS],
    );
  });

  it("reads an unrecognised create reply as a collision, not as success", async () => {
    // Refusing to believe we created a record is the safe direction: the
    // caller mints another id instead of handing out a token that may not
    // correspond to a stored digest.
    const { store } = stub("something else");

    expect(
      await store.create({ clientId: CLIENT_ID, secretHash: hashSecret("x"), createdAt: NOW }),
    ).toBe("exists");
  });

  it.each([
    ["recorded", "recorded"],
    ["skipped", "skipped"],
    ["revoked", "revoked"],
    ["missing", "missing"],
    ["anything unrecognised", "missing"],
  ])("decodes the %s touch reply", async (reply, expected) => {
    const { store } = stub(reply === "anything unrecognised" ? 42 : reply);

    expect(await store.touch(CLIENT_ID, NOW)).toBe(expected);
  });

  it.each([
    ["revoked", "revoked"],
    ["already_revoked", "already_revoked"],
    ["missing", "missing"],
  ])("decodes the %s revoke reply", async (reply, expected) => {
    const { store } = stub(reply);

    expect(await store.revoke(CLIENT_ID, NOW)).toBe(expected);
  });

  it.each([
    ["deleted", "deleted"],
    ["in_use", "in_use"],
    ["too_recent", "too_recent"],
    ["missing", "missing"],
  ])("decodes the %s cleanup reply", async (reply, expected) => {
    const { store } = stub(reply);

    expect(await store.deleteIfUnused(CLIENT_ID, NOW)).toBe(expected);
  });

  it("reads a stored record back", async () => {
    const secretHash = hashSecret(mintSecret());
    const hgetall = vi.fn(async () => ({
      secretHash,
      status: "active",
      createdAt: String(NOW),
      lastSeenAt: String(NOW + 1000),
    }));
    const store = new RedisClientCredentialStore({ eval: vi.fn(async () => null), hgetall });

    expect(await store.read(CLIENT_ID)).toEqual({
      clientId: CLIENT_ID,
      secretHash,
      status: "active",
      createdAt: NOW,
      lastSeenAt: NOW + 1000,
      revokedAt: null,
    });
  });

  it("reads numeric fields Upstash already parsed", async () => {
    // Upstash deserialises numeric-looking values, so both forms arrive.
    const hgetall = vi.fn(async () => ({
      secretHash: hashSecret("x"),
      status: "revoked",
      createdAt: NOW,
      revokedAt: NOW + 5,
    }));
    const store = new RedisClientCredentialStore({ eval: vi.fn(async () => null), hgetall });
    const record = await store.read(CLIENT_ID);

    expect(record?.createdAt).toBe(NOW);
    expect(record?.revokedAt).toBe(NOW + 5);
    expect(record?.lastSeenAt).toBeNull();
    expect(record?.status).toBe("revoked");
  });

  it("reads a missing key as absent", async () => {
    const store = new RedisClientCredentialStore({
      eval: vi.fn(async () => null),
      hgetall: vi.fn(async () => null),
    });

    expect(await store.read(CLIENT_ID)).toBeNull();
  });
});

describe("RedisClientCredentialStore.fromEnvironment", () => {
  it("refuses to build without credentials, and names the variables", async () => {
    await expect(RedisClientCredentialStore.fromEnvironment({})).rejects.toThrow(
      /KV_REST_API_URL/,
    );
  });

  it("does not leak the token into the error", async () => {
    const token = "UPSTASH-TOKEN-LEAK-CHECK";

    await expect(
      RedisClientCredentialStore.fromEnvironment({ KV_REST_API_TOKEN: token }),
    ).rejects.toThrow(expect.not.stringContaining(token) as unknown as string);
  });
});
