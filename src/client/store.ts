/**
 * Consumer credential storage (ADR-026, `contracts.md` Part 3).
 *
 * The store holds what authentication needs and nothing else: a digest, a
 * status, and three timestamps. It stores no recipe, no caption, and no user
 * content, so — like the idempotency records — it is request infrastructure
 * rather than an application database, and it does not reopen the no-database
 * scope decision (ADR-017).
 *
 * **Nothing here ever sees a raw secret.** Callers hash before writing and
 * compare digests when verifying, so a store implementation cannot leak a
 * credential it never receives.
 */

export type ClientStatus = "active" | "revoked";

export interface ClientCredential {
  clientId: string;
  /** SHA-256 hex of the secret component. Never the secret. */
  secretHash: string;
  status: ClientStatus;
  createdAt: number;
  /**
   * Epoch ms of a successful authentication, or `null` when the credential has
   * never authenticated anything.
   *
   * `null` is the orphan signal, and it is the only thing that distinguishes a
   * credential whose registration response was lost from one in daily use.
   */
  lastSeenAt: number | null;
  revokedAt: number | null;
}

export interface NewClientCredential {
  clientId: string;
  secretHash: string;
  createdAt: number;
}

/** `exists` is a collision, not a retry: registration mints a fresh id each time. */
export type CreateResult = "created" | "exists";

/**
 * `skipped` means the record was already fresh enough to leave alone — a
 * successful authentication that simply did not need a write.
 */
export type TouchResult = "recorded" | "skipped" | "missing" | "revoked";

export type RevokeResult = "revoked" | "already_revoked" | "missing";

export type CleanupResult = "deleted" | "in_use" | "too_recent" | "missing";

/**
 * How long a credential that has never authenticated is kept.
 *
 * The first successful authentication makes the record durable. Until then it
 * ages out on its own, which is what bounds the orphans the registration
 * design accepts: a response lost in transit leaves a credential nobody holds,
 * and a credential nobody holds can never authenticate anything.
 *
 * This is safe here in a way it explicitly was not for idempotency (ADR-025).
 * There, a vanished record would permit a second AnyList write solely because
 * time passed, and the duplicate could not be removed. Here, a vanished record
 * costs an unused credential its existence and the client registers again.
 */
export const UNUSED_CREDENTIAL_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * How stale `lastSeenAt` must be before a successful authentication rewrites it.
 *
 * Writing on every request would double the store cost of the hot path to keep
 * a timestamp accurate to the second that nothing reads that precisely. The
 * first write is never skipped, because that one is what makes the record
 * durable.
 */
export const LAST_SEEN_REFRESH_MS = 24 * 60 * 60 * 1000;

export interface ClientCredentialStore {
  /**
   * Write a new credential.
   *
   * Must not overwrite an existing `clientId`. A collision is cryptographically
   * improbable, but "improbable" is not "handled": silently replacing a record
   * would revoke a working credential by accident, so it returns `exists` and
   * leaves the stored record untouched.
   */
  create(record: NewClientCredential): Promise<CreateResult>;

  read(clientId: string): Promise<ClientCredential | null>;

  /**
   * Record a successful authentication.
   *
   * Must be a no-op on a revoked record. A revoked credential that could be
   * touched back into activity would defeat revocation, and the caller is not
   * in a position to prevent that — only the store can, atomically.
   */
  touch(clientId: string, now: number, refreshAfterMs?: number): Promise<TouchResult>;

  /**
   * Mark a credential revoked, keeping the record.
   *
   * Deletion is not the revocation mechanism: an absent record and a revoked
   * one answer the same 401, but only one of them is evidence that somebody
   * revoked it.
   */
  revoke(clientId: string, now: number): Promise<RevokeResult>;

  /**
   * Delete a credential that has never authenticated and is old enough.
   *
   * Refuses once `lastSeenAt` is set, whatever its age. Enumerating candidates
   * is deliberately not part of this interface — whatever runs cleanup owns
   * that, and no such mechanism exists yet.
   */
  deleteIfUnused(clientId: string, now: number, olderThanMs?: number): Promise<CleanupResult>;
}

/** Namespaced and versioned, matching the idempotency store's convention. */
export function clientKey(clientId: string): string {
  return `client:v1:${clientId}`;
}
