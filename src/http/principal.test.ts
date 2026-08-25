import { describe, expect, it } from "vitest";

import { MemoryClientCredentialStore } from "../client/memory-store.js";
import type {
  CleanupResult,
  ClientCredential,
  ClientCredentialStore,
  CreateResult,
  NewClientCredential,
  RevokeResult,
  TouchResult,
} from "../client/store.js";
import { buildToken, mintClientId, mintCredential, mintSecret } from "../client/token.js";
import { resolvePrincipal, type PrincipalResolution } from "./principal.js";

const INTERNAL_KEY = "RECIPE-KEY-for-tests";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Counts reads and writes, so "no store lookup" can be asserted rather than assumed. */
class CountingStore implements ClientCredentialStore {
  reads = 0;
  touches = 0;

  constructor(private readonly inner: ClientCredentialStore) {}

  create(record: NewClientCredential): Promise<CreateResult> {
    return this.inner.create(record);
  }

  read(clientId: string): Promise<ClientCredential | null> {
    this.reads += 1;
    return this.inner.read(clientId);
  }

  touch(clientId: string, now: number, refreshAfterMs?: number): Promise<TouchResult> {
    this.touches += 1;
    return this.inner.touch(clientId, now, refreshAfterMs);
  }

  revoke(clientId: string, now: number): Promise<RevokeResult> {
    return this.inner.revoke(clientId, now);
  }

  deleteIfUnused(clientId: string, now: number, olderThanMs?: number): Promise<CleanupResult> {
    return this.inner.deleteIfUnused(clientId, now, olderThanMs);
  }
}

async function seeded(now: number = Date.now()) {
  const inner = new MemoryClientCredentialStore();
  const credential = mintCredential();

  await inner.create({
    clientId: credential.clientId,
    secretHash: credential.secretHash,
    createdAt: now,
  });

  return { store: new CountingStore(inner), inner, credential, now };
}

function resolve(
  header: string | undefined,
  clientStore: ClientCredentialStore | undefined,
  now: number = Date.now(),
): Promise<PrincipalResolution> {
  return resolvePrincipal({ header, internalSecret: INTERNAL_KEY, clientStore, now });
}

describe("the internal key", () => {
  it("resolves to the internal principal", async () => {
    const { store } = await seeded();

    expect(await resolve(`Bearer ${INTERNAL_KEY}`, store)).toEqual({
      outcome: "authenticated",
      principal: { kind: "internal" },
    });
  });

  it("never touches the credential store", async () => {
    // CLI and smoke traffic must pay none of the consumer path's latency.
    const { store } = await seeded();

    await resolve(`Bearer ${INTERNAL_KEY}`, store);

    expect(store.reads).toBe(0);
    expect(store.touches).toBe(0);
  });

  it("still rejects a wrong key, and does not fall through to a store lookup", async () => {
    const { store } = await seeded();

    expect(await resolve("Bearer nope", store)).toEqual({ outcome: "unauthorized" });
    expect(store.reads).toBe(0);
  });

  it.each([
    ["a missing header", undefined],
    ["an empty header", ""],
    ["no scheme", INTERNAL_KEY],
    ["a lowercase scheme", `bearer ${INTERNAL_KEY}`],
    ["an empty bearer", "Bearer "],
    ["a leading space", `Bearer  ${INTERNAL_KEY}`],
    ["the wrong scheme", `Basic ${INTERNAL_KEY}`],
  ])("rejects %s exactly as before", async (_label, header) => {
    const { store } = await seeded();

    expect(await resolve(header, store)).toEqual({ outcome: "unauthorized" });
    expect(store.reads).toBe(0);
  });
});

describe("an installation token", () => {
  it("resolves to the installation principal, carrying its clientId", async () => {
    const { store, credential } = await seeded();

    expect(await resolve(`Bearer ${credential.token}`, store)).toEqual({
      outcome: "authenticated",
      principal: { kind: "installation", clientId: credential.clientId },
    });
  });

  it("records the first successful use", async () => {
    const { store, inner, credential, now } = await seeded();

    await resolve(`Bearer ${credential.token}`, store, now + 1000);

    expect((await inner.read(credential.clientId))?.lastSeenAt).toBe(now + 1000);
  });

  it("makes the credential durable on first use", async () => {
    const { store, inner, credential, now } = await seeded();

    await resolve(`Bearer ${credential.token}`, store, now + 1000);

    // Past the seven-day unused window: a credential in use does not expire.
    expect(await inner.read(credential.clientId, now + 30 * DAY_MS)).not.toBeNull();
  });

  it("skips the rewrite on a second use within the day", async () => {
    const { store, inner, credential, now } = await seeded();

    await resolve(`Bearer ${credential.token}`, store, now);
    await resolve(`Bearer ${credential.token}`, store, now + 60_000);

    expect((await inner.read(credential.clientId))?.lastSeenAt).toBe(now);
    expect(store.touches).toBe(2);
  });

  it("rejects a malformed token without a store lookup", async () => {
    const { store } = await seeded();

    for (const bad of ["sr1_short", "sr2_a_b", "not-a-token", `sr1_${mintClientId()}_x`]) {
      expect(await resolve(`Bearer ${bad}`, store)).toEqual({ outcome: "unauthorized" });
    }

    expect(store.reads).toBe(0);
  });

  it("rejects an unknown clientId", async () => {
    const { store } = await seeded();
    const stranger = buildToken(mintClientId(), mintSecret());

    expect(await resolve(`Bearer ${stranger}`, store)).toEqual({ outcome: "unauthorized" });
    expect(store.reads).toBe(1);
    expect(store.touches).toBe(0);
  });

  it("rejects a wrong secret, and leaves no trace on the record", async () => {
    const { store, inner, credential } = await seeded();
    const forged = buildToken(credential.clientId, mintSecret());

    expect(await resolve(`Bearer ${forged}`, store)).toEqual({ outcome: "unauthorized" });

    // A failed verification must not mark the credential as used: doing so
    // would keep an orphan alive on the strength of a wrong guess.
    expect(store.touches).toBe(0);
    expect((await inner.read(credential.clientId))?.lastSeenAt).toBeNull();
  });

  it("rejects a revoked credential without touching it", async () => {
    const { store, inner, credential, now } = await seeded();
    await inner.revoke(credential.clientId, now);

    expect(await resolve(`Bearer ${credential.token}`, store, now + 1000)).toEqual({
      outcome: "unauthorized",
    });
    expect(store.touches).toBe(0);
  });

  it("is refused where the deployment has no credential store", async () => {
    const { credential } = await seeded();

    // Structurally valid, and nowhere to check it. Refused, never accepted.
    expect(await resolve(`Bearer ${credential.token}`, undefined)).toEqual({
      outcome: "unauthorized",
    });
  });

  it("answers the same way for unknown, wrong, and revoked", async () => {
    const { store, inner, credential, now } = await seeded();
    const answers: PrincipalResolution[] = [];

    answers.push(await resolve(`Bearer ${buildToken(mintClientId(), mintSecret())}`, store));
    answers.push(await resolve(`Bearer ${buildToken(credential.clientId, mintSecret())}`, store));
    await inner.revoke(credential.clientId, now);
    answers.push(await resolve(`Bearer ${credential.token}`, store, now + 1));

    // A caller that could tell these apart could enumerate valid client ids.
    expect(answers).toEqual([
      { outcome: "unauthorized" },
      { outcome: "unauthorized" },
      { outcome: "unauthorized" },
    ]);
  });
});

describe("races and store failures", () => {
  it("fails when the credential is revoked between verification and touch", async () => {
    const { inner, credential, now } = await seeded();

    // The window the atomic touch exists to close.
    const racing: ClientCredentialStore = {
      ...inner,
      read: async (clientId) => {
        const record = await inner.read(clientId);
        await inner.revoke(clientId, now);
        return record;
      },
      touch: (clientId, at, refreshAfterMs) => inner.touch(clientId, at, refreshAfterMs),
      create: (record) => inner.create(record),
      revoke: (clientId, at) => inner.revoke(clientId, at),
      deleteIfUnused: (clientId, at, olderThanMs) =>
        inner.deleteIfUnused(clientId, at, olderThanMs),
    };

    // The read still sees an active record and the secret still verifies, so
    // only the touch can catch it — and its answer has to win.
    expect(await resolve(`Bearer ${credential.token}`, racing, now + 1)).toEqual({
      outcome: "unauthorized",
    });
  });

  it("fails when the credential is deleted between verification and touch", async () => {
    const { inner, credential, now } = await seeded();

    const racing: ClientCredentialStore = {
      ...inner,
      read: async (clientId) => {
        const record = await inner.read(clientId);
        await inner.deleteIfUnused(clientId, now + 1, 0);
        return record;
      },
      touch: (clientId, at, refreshAfterMs) => inner.touch(clientId, at, refreshAfterMs),
      create: (record) => inner.create(record),
      revoke: (clientId, at) => inner.revoke(clientId, at),
      deleteIfUnused: (clientId, at, olderThanMs) =>
        inner.deleteIfUnused(clientId, at, olderThanMs),
    };

    expect(await resolve(`Bearer ${credential.token}`, racing, now + 1)).toEqual({
      outcome: "unauthorized",
    });
  });

  it("reports a failing read as unavailable rather than as a bad credential", async () => {
    const { inner, credential } = await seeded();
    const broken: ClientCredentialStore = {
      ...inner,
      read: () => Promise.reject(new Error("upstash: ECONNRESET")),
      touch: (clientId, at, refreshAfterMs) => inner.touch(clientId, at, refreshAfterMs),
      create: (record) => inner.create(record),
      revoke: (clientId, at) => inner.revoke(clientId, at),
      deleteIfUnused: (clientId, at, olderThanMs) =>
        inner.deleteIfUnused(clientId, at, olderThanMs),
    };

    expect(await resolve(`Bearer ${credential.token}`, broken)).toEqual({
      outcome: "unavailable",
    });
  });

  it("reports a failing touch as unavailable, and issues no principal", async () => {
    const { inner, credential } = await seeded();
    const broken: ClientCredentialStore = {
      ...inner,
      read: (clientId) => inner.read(clientId),
      touch: () => Promise.reject(new Error("upstash: ECONNRESET")),
      create: (record) => inner.create(record),
      revoke: (clientId, at) => inner.revoke(clientId, at),
      deleteIfUnused: (clientId, at, olderThanMs) =>
        inner.deleteIfUnused(clientId, at, olderThanMs),
    };

    const resolution = await resolve(`Bearer ${credential.token}`, broken);

    expect(resolution).toEqual({ outcome: "unavailable" });
    expect(resolution).not.toHaveProperty("principal");
  });

  it("never leaks store detail into the resolution", async () => {
    const { inner, credential } = await seeded();
    const broken: ClientCredentialStore = {
      ...inner,
      read: () => Promise.reject(new Error("upstash://user:hunter2@host/db")),
      touch: (clientId, at, refreshAfterMs) => inner.touch(clientId, at, refreshAfterMs),
      create: (record) => inner.create(record),
      revoke: (clientId, at) => inner.revoke(clientId, at),
      deleteIfUnused: (clientId, at, olderThanMs) =>
        inner.deleteIfUnused(clientId, at, olderThanMs),
    };

    expect(JSON.stringify(await resolve(`Bearer ${credential.token}`, broken))).not.toContain(
      "hunter2",
    );
  });
});
