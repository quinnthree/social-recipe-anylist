import { describe, expect, it } from "vitest";

import { MemoryClientCredentialStore } from "../../src/client/memory-store.js";
import {
  clientKey,
  LAST_SEEN_REFRESH_MS,
  UNUSED_CREDENTIAL_TTL_SECONDS,
} from "../../src/client/store.js";
import { hashSecret, mintClientId, mintSecret } from "../../src/client/token.js";
import { runClientCredentialStoreConformance } from "./client-credential-contract.js";

/**
 * Independent verification of the credential-store contract (ADR-026).
 *
 * The suite runs here against the in-process store. Running the same suite
 * against real Upstash is a LIVE EXTERNAL release-gate item — see
 * `tests/live/client-credential-conformance.live.test.ts`. The suite takes a
 * factory precisely so that needs no rewriting.
 */

describe("client credential store conformance (in-process store)", () => {
  runClientCredentialStoreConformance({
    createStore: () => new MemoryClientCredentialStore(),
  });
});

describe("orphan retention (ADR-026)", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it("drops a credential that never authenticated, once it is old enough", async () => {
    const store = new MemoryClientCredentialStore();
    const clientId = mintClientId();
    const now = Date.now();

    await store.create({ clientId, secretHash: hashSecret(mintSecret()), createdAt: now });

    // A registration response lost in transit leaves a credential nobody
    // holds. It ages out on its own; no sweeper is required for the default.
    expect(await store.read(clientId, now + 6 * DAY_MS)).not.toBeNull();
    expect(await store.read(clientId, now + 8 * DAY_MS)).toBeNull();
  });

  it("makes a credential durable the moment it first authenticates", async () => {
    const store = new MemoryClientCredentialStore();
    const clientId = mintClientId();
    const now = Date.now();

    await store.create({ clientId, secretHash: hashSecret(mintSecret()), createdAt: now });
    await store.touch(clientId, now + 60_000);

    // Well past the unused window, and past any renewal a rolling TTL would
    // have needed: a credential in use does not expire.
    expect(await store.read(clientId, now + 400 * DAY_MS)).not.toBeNull();
  });

  it("keeps a revoked-but-unused credential on its original retention", async () => {
    const store = new MemoryClientCredentialStore();
    const clientId = mintClientId();
    const now = Date.now();

    await store.create({ clientId, secretHash: hashSecret(mintSecret()), createdAt: now });
    await store.revoke(clientId, now + 60_000);

    // Revocation changes what the record says, not how long it is kept.
    expect((await store.read(clientId, now + DAY_MS))?.status).toBe("revoked");
    expect(await store.read(clientId, now + 8 * DAY_MS)).toBeNull();
  });
});

describe("store constants match the approved contract", () => {
  it("keeps an unused credential for seven days", () => {
    expect(UNUSED_CREDENTIAL_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
  });

  it("refreshes lastSeenAt no more than once a day", () => {
    expect(LAST_SEEN_REFRESH_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("namespaces and versions the key", () => {
    const clientId = mintClientId();

    expect(clientKey(clientId)).toBe(`client:v1:${clientId}`);
    // The clientId is public, so — unlike an Idempotency-Key — it is not
    // hashed into the store key. It is the operational identifier.
    expect(clientKey(clientId)).toContain(clientId);
  });
});
