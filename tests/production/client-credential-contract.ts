import { expect, it } from "vitest";

import type { ClientCredentialStore } from "../../src/client/store.js";
import { hashSecret, mintClientId, mintSecret } from "../../src/client/token.js";

/**
 * The consumer credential store's semantics, as a suite that runs against any
 * implementation (ADR-026).
 *
 * The in-process store is what normal CI exercises; the same suite runs against
 * real Upstash as a live-gated release-gate step. That is the only way to catch
 * the two diverging, because the in-process store gets its atomicity
 * structurally from the event loop while Redis has to buy it with a Lua script,
 * and only one of those is what runs in production.
 *
 * Every case supplies its own `now` and its own freshly minted clientId, so the
 * suite is order-independent and safe to run against a shared store.
 */

export interface ClientStoreSuiteOptions {
  createStore: () => ClientCredentialStore | Promise<ClientCredentialStore>;
}

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export function runClientCredentialStoreConformance({
  createStore,
}: ClientStoreSuiteOptions): void {
  const withStore = async (
    body: (store: ClientCredentialStore, clientId: string, now: number) => Promise<void>,
  ): Promise<void> => {
    const store = await createStore();
    await body(store, mintClientId(), Date.now());
  };

  it("creates a record and reads it back", async () => {
    await withStore(async (store, clientId, now) => {
      const secretHash = hashSecret(mintSecret());

      expect(await store.create({ clientId, secretHash, createdAt: now })).toBe("created");

      const record = await store.read(clientId);

      expect(record).toEqual({
        clientId,
        secretHash,
        status: "active",
        createdAt: now,
        lastSeenAt: null,
        revokedAt: null,
      });
    });
  });

  it("reads a missing clientId as absent", async () => {
    await withStore(async (store) => {
      expect(await store.read(mintClientId())).toBeNull();
    });
  });

  it("stores the digest and nothing that could reconstruct the secret", async () => {
    await withStore(async (store, clientId, now) => {
      const secret = mintSecret();
      await store.create({ clientId, secretHash: hashSecret(secret), createdAt: now });

      const record = await store.read(clientId);
      const serialised = JSON.stringify(record);

      expect(serialised).not.toContain(secret);
      expect(record?.secretHash).toBe(hashSecret(secret));
      expect(Object.keys(record ?? {}).sort()).toEqual([
        "clientId",
        "createdAt",
        "lastSeenAt",
        "revokedAt",
        "secretHash",
        "status",
      ]);
    });
  });

  it("refuses to overwrite an existing clientId", async () => {
    await withStore(async (store, clientId, now) => {
      const original = hashSecret(mintSecret());
      await store.create({ clientId, secretHash: original, createdAt: now });

      // A collision is improbable, not impossible. Overwriting would silently
      // revoke a working credential.
      expect(
        await store.create({
          clientId,
          secretHash: hashSecret(mintSecret()),
          createdAt: now + MINUTE_MS,
        }),
      ).toBe("exists");

      const record = await store.read(clientId);
      expect(record?.secretHash).toBe(original);
      expect(record?.createdAt).toBe(now);
    });
  });

  it("lets exactly one of several concurrent creates win", async () => {
    await withStore(async (store, clientId, now) => {
      const attempts = await Promise.all(
        Array.from({ length: 8 }, () =>
          store.create({ clientId, secretHash: hashSecret(mintSecret()), createdAt: now }),
        ),
      );

      expect(attempts.filter((result) => result === "created")).toHaveLength(1);
      expect(attempts.filter((result) => result === "exists")).toHaveLength(7);
    });
  });

  it("records the first successful authentication", async () => {
    await withStore(async (store, clientId, now) => {
      await store.create({ clientId, secretHash: hashSecret(mintSecret()), createdAt: now });

      expect(await store.touch(clientId, now + MINUTE_MS)).toBe("recorded");
      expect((await store.read(clientId))?.lastSeenAt).toBe(now + MINUTE_MS);
    });
  });

  it("skips a rewrite while lastSeenAt is fresh", async () => {
    await withStore(async (store, clientId, now) => {
      await store.create({ clientId, secretHash: hashSecret(mintSecret()), createdAt: now });
      await store.touch(clientId, now, DAY_MS);

      // Writing on every request would double the store cost of the hot path
      // for a timestamp nothing reads to the second.
      expect(await store.touch(clientId, now + MINUTE_MS, DAY_MS)).toBe("skipped");
      expect((await store.read(clientId))?.lastSeenAt).toBe(now);
    });
  });

  it("rewrites lastSeenAt once it is stale", async () => {
    await withStore(async (store, clientId, now) => {
      await store.create({ clientId, secretHash: hashSecret(mintSecret()), createdAt: now });
      await store.touch(clientId, now, DAY_MS);

      const later = now + DAY_MS + MINUTE_MS;
      expect(await store.touch(clientId, later, DAY_MS)).toBe("recorded");
      expect((await store.read(clientId))?.lastSeenAt).toBe(later);
    });
  });

  it("reports a touch of a missing record", async () => {
    await withStore(async (store, _clientId, now) => {
      expect(await store.touch(mintClientId(), now)).toBe("missing");
    });
  });

  it("revokes without deleting, and keeps the record's history", async () => {
    await withStore(async (store, clientId, now) => {
      const secretHash = hashSecret(mintSecret());
      await store.create({ clientId, secretHash, createdAt: now });

      const revokedAt = now + MINUTE_MS;
      expect(await store.revoke(clientId, revokedAt)).toBe("revoked");

      const record = await store.read(clientId);
      expect(record?.status).toBe("revoked");
      expect(record?.revokedAt).toBe(revokedAt);
      expect(record?.createdAt).toBe(now);
      expect(record?.secretHash).toBe(secretHash);
    });
  });

  it("reports a second revocation rather than rewriting the first", async () => {
    await withStore(async (store, clientId, now) => {
      await store.create({ clientId, secretHash: hashSecret(mintSecret()), createdAt: now });
      await store.revoke(clientId, now + MINUTE_MS);

      expect(await store.revoke(clientId, now + 2 * MINUTE_MS)).toBe("already_revoked");
      expect((await store.read(clientId))?.revokedAt).toBe(now + MINUTE_MS);
    });
  });

  it("never lets a touch resurrect a revoked credential", async () => {
    await withStore(async (store, clientId, now) => {
      await store.create({ clientId, secretHash: hashSecret(mintSecret()), createdAt: now });
      await store.touch(clientId, now);
      await store.revoke(clientId, now + MINUTE_MS);

      // Revocation has to survive requests that were authorised a moment
      // earlier and are still in flight.
      expect(await store.touch(clientId, now + 2 * MINUTE_MS)).toBe("revoked");

      const record = await store.read(clientId);
      expect(record?.status).toBe("revoked");
      expect(record?.lastSeenAt).toBe(now);
    });
  });

  it("reports revocation of a missing record", async () => {
    await withStore(async (store, _clientId, now) => {
      expect(await store.revoke(mintClientId(), now)).toBe("missing");
    });
  });

  it("deletes a credential that never authenticated and is old enough", async () => {
    await withStore(async (store, clientId, now) => {
      await store.create({ clientId, secretHash: hashSecret(mintSecret()), createdAt: now });

      expect(await store.deleteIfUnused(clientId, now + 2 * MINUTE_MS, MINUTE_MS)).toBe("deleted");
      expect(await store.read(clientId)).toBeNull();
    });
  });

  it("refuses to delete a credential that has authenticated, whatever its age", async () => {
    await withStore(async (store, clientId, now) => {
      await store.create({ clientId, secretHash: hashSecret(mintSecret()), createdAt: now });
      await store.touch(clientId, now);

      expect(await store.deleteIfUnused(clientId, now + 365 * DAY_MS, MINUTE_MS)).toBe("in_use");
      expect(await store.read(clientId)).not.toBeNull();
    });
  });

  it("refuses to delete a credential that is still recent", async () => {
    await withStore(async (store, clientId, now) => {
      await store.create({ clientId, secretHash: hashSecret(mintSecret()), createdAt: now });

      expect(await store.deleteIfUnused(clientId, now + MINUTE_MS, DAY_MS)).toBe("too_recent");
      expect(await store.read(clientId)).not.toBeNull();
    });
  });

  it("reports cleanup of a missing record", async () => {
    await withStore(async (store, _clientId, now) => {
      expect(await store.deleteIfUnused(mintClientId(), now, MINUTE_MS)).toBe("missing");
    });
  });

  it("cleans up only the record it was asked about", async () => {
    await withStore(async (store, clientId, now) => {
      const neighbour = mintClientId();
      await store.create({ clientId, secretHash: hashSecret(mintSecret()), createdAt: now });
      await store.create({
        clientId: neighbour,
        secretHash: hashSecret(mintSecret()),
        createdAt: now,
      });

      await store.deleteIfUnused(clientId, now + 2 * MINUTE_MS, MINUTE_MS);

      expect(await store.read(clientId)).toBeNull();
      expect(await store.read(neighbour)).not.toBeNull();
    });
  });

  it("round-trips timestamps as numbers, not as strings", async () => {
    await withStore(async (store, clientId, now) => {
      await store.create({ clientId, secretHash: hashSecret(mintSecret()), createdAt: now });
      await store.touch(clientId, now + MINUTE_MS);
      await store.revoke(clientId, now + 2 * MINUTE_MS);

      const record = await store.read(clientId);

      expect(typeof record?.createdAt).toBe("number");
      expect(typeof record?.lastSeenAt).toBe("number");
      expect(typeof record?.revokedAt).toBe("number");
      expect(record?.status).toBe("revoked");
    });
  });
}
