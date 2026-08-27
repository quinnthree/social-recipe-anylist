import {
  RETENTION_SECONDS,
  type ClaimRequest,
  type ClaimResult,
  type IdempotencyRecord,
  type IdempotencyStore,
  type StoredResult,
} from "./store.js";

interface Entry {
  record: IdempotencyRecord;
  /** Epoch ms. Models the store's record TTL, which is not the lease. */
  expiresAt: number;
}

/**
 * An in-process `IdempotencyStore` for tests and local development.
 *
 * **This is not acceptable in production and is never constructed by the
 * server** (ADR-012). It is lost on restart and invisible to other instances,
 * which is worse than no idempotency at all because it presents a guarantee it
 * cannot keep — and on Fluid compute, where instances are reused, it would
 * appear to work in every manual test before failing on the first scale-out.
 *
 * It exists so the route logic can be tested exhaustively without a network,
 * and it models the real semantics faithfully: state-dependent retention, the
 * lease/TTL split, and claim atomicity.
 *
 * Atomicity here is structural. `claim` contains **no `await`**, so the
 * JavaScript event loop cannot interleave two claims — which is exactly the
 * property the Redis implementation buys with a Lua script.
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, Entry>();

  claim(request: ClaimRequest): Promise<ClaimResult> {
    return Promise.resolve(this.claimSync(request));
  }

  /** Synchronous by design — see the note on atomicity above. */
  private claimSync({
    key,
    fingerprint,
    requestId,
    destinationBinding,
    now,
    leaseMs,
  }: ClaimRequest): ClaimResult {
    const existing = this.live(key, now);

    if (existing === null) {
      this.write(
        key,
        freshClaim(fingerprint, requestId, destinationBinding, now, leaseMs),
        RETENTION_SECONDS.IN_PROGRESS,
        now,
      );
      return { status: "claimed" };
    }

    // Checked first, so a mismatched retry can never take the claim.
    if (existing.fingerprint !== fingerprint) return { status: "conflict" };

    switch (existing.state) {
      case "COMPLETED":
        return existing.result === null
          ? { status: "ambiguous" }
          : {
              status: "completed",
              result: existing.result,
              originalRequestId: existing.requestId,
            };

      case "AMBIGUOUS":
        return { status: "ambiguous" };

      case "FAILED_SAFE":
        this.write(
          key,
          {
            ...freshClaim(fingerprint, requestId, destinationBinding, now, leaseMs),
            createdAt: existing.createdAt,
            // The *existing* binding, never the incoming one. A re-claim
            // continues a record whose first attempt already chose a
            // destination; overwriting it here would let a record quietly
            // change what it says it targeted.
            destinationBinding: existing.destinationBinding,
          },
          RETENTION_SECONDS.IN_PROGRESS,
          now,
        );
        return { status: "claimed" };

      case "IN_PROGRESS":
        if (now <= existing.leaseExpiresAt) return { status: "in_progress" };

        // A stale lease is not evidence that nothing was written. The record is
        // preserved and converted, never deleted and never reclaimed.
        this.write(
          key,
          { ...existing, state: "AMBIGUOUS", failureCode: "lease_expired", updatedAt: now },
          RETENTION_SECONDS.AMBIGUOUS,
          now,
        );
        return { status: "ambiguous" };
    }
  }

  complete(key: string, requestId: string, result: StoredResult, now: number): Promise<void> {
    const held = this.heldBy(key, requestId, now);
    if (held !== null) {
      this.write(
        key,
        { ...held, state: "COMPLETED", result, failureCode: null, updatedAt: now },
        RETENTION_SECONDS.COMPLETED,
        now,
      );
    }
    return Promise.resolve();
  }

  fail(
    key: string,
    requestId: string,
    state: "FAILED_SAFE" | "AMBIGUOUS",
    failureCode: string,
    now: number,
  ): Promise<void> {
    const held = this.heldBy(key, requestId, now);
    if (held !== null) {
      this.write(
        key,
        { ...held, state, failureCode, updatedAt: now },
        RETENTION_SECONDS[state],
        now,
      );
    }
    return Promise.resolve();
  }

  read(key: string, now: number = Date.now()): Promise<IdempotencyRecord | null> {
    const record = this.live(key, now);
    return Promise.resolve(record === null ? null : { ...record });
  }

  /**
   * A transition only applies while this request still holds the claim.
   *
   * Without the guard, a request whose lease expired — and whose record has
   * therefore already been converted to `AMBIGUOUS` — could finish late and
   * overwrite that uncertainty with a confident answer nobody is waiting for.
   */
  private heldBy(key: string, requestId: string, now: number): IdempotencyRecord | null {
    const record = this.live(key, now);
    if (record === null) return null;
    if (record.state !== "IN_PROGRESS" || record.requestId !== requestId) return null;

    return record;
  }

  private live(key: string, now: number): IdempotencyRecord | null {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;

    if (now >= entry.expiresAt) {
      this.entries.delete(key);
      return null;
    }

    return entry.record;
  }

  private write(key: string, record: IdempotencyRecord, ttlSeconds: number, now: number): void {
    this.entries.set(key, { record, expiresAt: now + ttlSeconds * 1000 });
  }
}

function freshClaim(
  fingerprint: string,
  requestId: string,
  destinationBinding: string,
  now: number,
  leaseMs: number,
): IdempotencyRecord {
  return {
    state: "IN_PROGRESS",
    fingerprint,
    destinationBinding,
    requestId,
    leaseExpiresAt: now + leaseMs,
    result: null,
    failureCode: null,
    createdAt: now,
    updatedAt: now,
  };
}
