import {
  LAST_SEEN_REFRESH_MS,
  UNUSED_CREDENTIAL_TTL_SECONDS,
  type ClientCredential,
  type ClientCredentialStore,
  type CleanupResult,
  type CreateResult,
  type NewClientCredential,
  type RevokeResult,
  type TouchResult,
} from "./store.js";

interface Entry {
  record: ClientCredential;
  /** Epoch ms, or `null` once the credential has authenticated and become durable. */
  expiresAt: number | null;
}

/**
 * An in-process `ClientCredentialStore` for tests and local development.
 *
 * It is held to the same semantics as the Redis implementation rather than a
 * looser approximation, because the conformance suite runs against both and a
 * more permissive memory store would let a real divergence pass.
 *
 * Atomicity here is structural: every operation below is synchronous, so the
 * event loop cannot interleave two of them — the property the Redis
 * implementation has to buy with a Lua script.
 */
export class MemoryClientCredentialStore implements ClientCredentialStore {
  private readonly entries = new Map<string, Entry>();

  create(record: NewClientCredential): Promise<CreateResult> {
    return Promise.resolve(this.createSync(record));
  }

  read(clientId: string, now: number = Date.now()): Promise<ClientCredential | null> {
    const record = this.live(clientId, now);
    return Promise.resolve(record === null ? null : { ...record });
  }

  touch(
    clientId: string,
    now: number,
    refreshAfterMs: number = LAST_SEEN_REFRESH_MS,
  ): Promise<TouchResult> {
    return Promise.resolve(this.touchSync(clientId, now, refreshAfterMs));
  }

  revoke(clientId: string, now: number): Promise<RevokeResult> {
    return Promise.resolve(this.revokeSync(clientId, now));
  }

  deleteIfUnused(
    clientId: string,
    now: number,
    olderThanMs: number = UNUSED_CREDENTIAL_TTL_SECONDS * 1000,
  ): Promise<CleanupResult> {
    return Promise.resolve(this.deleteIfUnusedSync(clientId, now, olderThanMs));
  }

  private createSync({ clientId, secretHash, createdAt }: NewClientCredential): CreateResult {
    if (this.live(clientId, createdAt) !== null) return "exists";

    this.entries.set(clientId, {
      record: {
        clientId,
        secretHash,
        status: "active",
        createdAt,
        lastSeenAt: null,
        revokedAt: null,
      },
      expiresAt: createdAt + UNUSED_CREDENTIAL_TTL_SECONDS * 1000,
    });

    return "created";
  }

  private touchSync(clientId: string, now: number, refreshAfterMs: number): TouchResult {
    const record = this.live(clientId, now);
    if (record === null) return "missing";
    if (record.status === "revoked") return "revoked";

    // The first write is never skipped: it is what makes the record durable.
    if (record.lastSeenAt !== null && now - record.lastSeenAt < refreshAfterMs) {
      return "skipped";
    }

    this.entries.set(clientId, {
      record: { ...record, lastSeenAt: now },
      expiresAt: null,
    });

    return "recorded";
  }

  private revokeSync(clientId: string, now: number): RevokeResult {
    const entry = this.entries.get(clientId);
    const record = this.live(clientId, now);

    if (record === null || entry === undefined) return "missing";
    if (record.status === "revoked") return "already_revoked";

    // Retention is untouched. A revoked credential that was never used still
    // ages out; one that was used stays durable, as the record it is.
    this.entries.set(clientId, {
      record: { ...record, status: "revoked", revokedAt: now },
      expiresAt: entry.expiresAt,
    });

    return "revoked";
  }

  private deleteIfUnusedSync(clientId: string, now: number, olderThanMs: number): CleanupResult {
    const record = this.live(clientId, now);

    if (record === null) return "missing";
    if (record.lastSeenAt !== null) return "in_use";
    if (now - record.createdAt < olderThanMs) return "too_recent";

    this.entries.delete(clientId);

    return "deleted";
  }

  private live(clientId: string, now: number): ClientCredential | null {
    const entry = this.entries.get(clientId);
    if (entry === undefined) return null;

    if (entry.expiresAt !== null && now >= entry.expiresAt) {
      this.entries.delete(clientId);
      return null;
    }

    return entry.record;
  }
}
