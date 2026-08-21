import { createHash } from "node:crypto";

/**
 * Idempotency state, frozen by the contract (ADR-012, ADR-025).
 *
 * `NEW` is deliberately absent: it is not a stored state, it is the absence of
 * a record. Making it a value would invite code that writes it.
 */
export type IdempotencyState = "IN_PROGRESS" | "COMPLETED" | "FAILED_SAFE" | "AMBIGUOUS";

/** The only thing an idempotency record ever carries about a recipe. */
export interface StoredResult {
  id: string;
  name: string;
}

export interface IdempotencyRecord {
  state: IdempotencyState;
  fingerprint: string;
  /** The request that most recently claimed this key. */
  requestId: string;
  /** Epoch ms. Meaningful only while `state` is `IN_PROGRESS`. */
  leaseExpiresAt: number;
  result: StoredResult | null;
  failureCode: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * The outcome of an atomic claim.
 *
 * `FAILED_SAFE` never appears here, because it is never something a caller has
 * to handle: a matching-fingerprint claim against a `FAILED_SAFE` record is
 * itself the `FAILED_SAFE → IN_PROGRESS` transition, and returns `claimed`.
 */
export type ClaimResult =
  | { status: "claimed" }
  | { status: "conflict" }
  | { status: "in_progress" }
  | { status: "ambiguous" }
  | { status: "completed"; result: StoredResult; originalRequestId: string };

export interface ClaimRequest {
  key: string;
  fingerprint: string;
  requestId: string;
  now: number;
  /** How long active execution is still expected. Not the record's TTL. */
  leaseMs: number;
}

/**
 * Durable, shared idempotency state.
 *
 * The interface exists so the backing store is replaceable without touching
 * route logic (ADR-017). Everything an implementation must guarantee is stated
 * on `claim`, because that is where correctness actually lives.
 */
export interface IdempotencyStore {
  /**
   * Atomically resolve the key's state and, where the state permits it, take
   * the claim.
   *
   * Implementations **must** perform all of the following as one indivisible
   * operation, or two concurrent same-key requests can both believe they won:
   *
   * 1. No record → write `IN_PROGRESS` and return `claimed`.
   * 2. Fingerprint differs → `conflict`. Checked before anything else, so a
   *    mismatched retry can never claim.
   * 3. `COMPLETED` → `completed` with the recorded result.
   * 4. `AMBIGUOUS` → `ambiguous`.
   * 5. `FAILED_SAFE` → re-claim to `IN_PROGRESS` and return `claimed`.
   * 6. `IN_PROGRESS` with a live lease → `in_progress`.
   * 7. `IN_PROGRESS` with a **stale** lease → transition the record to
   *    `AMBIGUOUS` and return `ambiguous`. The record is never deleted and
   *    never becomes claimable: expiry is not evidence of safety (ADR-025).
   */
  claim(request: ClaimRequest): Promise<ClaimResult>;

  /** Record a verified export. No-op unless this request still holds the claim. */
  complete(key: string, requestId: string, result: StoredResult, now: number): Promise<void>;

  /** Record a failure. No-op unless this request still holds the claim. */
  fail(
    key: string,
    requestId: string,
    state: "FAILED_SAFE" | "AMBIGUOUS",
    failureCode: string,
    now: number,
  ): Promise<void>;

  /** Raw read, for diagnostics and tests. Performs no state transition. */
  read(key: string): Promise<IdempotencyRecord | null>;
}

/**
 * Retention is state-dependent, and it is not a lease (ADR-025).
 *
 * A flat 24-hour TTL would be unsafe: an `IN_PROGRESS` or `AMBIGUOUS` record
 * would expire, the key would read as unseen, and a second AnyList write could
 * happen *solely because time passed*. Since `deleteRecipe()` cannot reliably
 * clean up a duplicate (ADR-021), that write would be unfixable.
 */
export const RETENTION_SECONDS = {
  COMPLETED: 24 * 60 * 60,
  FAILED_SAFE: 24 * 60 * 60,
  /** Long, so a delayed retry cannot outlive the record and be treated as new. */
  IN_PROGRESS: 30 * 24 * 60 * 60,
  /** Uncertainty is preserved, not erased. */
  AMBIGUOUS: 30 * 24 * 60 * 60,
} as const;

/**
 * How long a claim is presumed to still be executing.
 *
 * Comfortably longer than the platform's 120 s function ceiling, so a request
 * that is genuinely still running is never mistaken for an abandoned one, and
 * a request that was killed is recognised soon after it could not still be
 * alive.
 */
export const DEFAULT_LEASE_MS = 150_000;

/**
 * Namespaced and hashed.
 *
 * Route-scoped, so the same client key used on two routes cannot collide.
 * Hashed, so the raw client key never reaches a store key, a log line, or an
 * error. Version-prefixed, because changing the fingerprint normalisation must
 * invalidate old records rather than silently mismatch them.
 */
export function storeKey(route: string, idempotencyKey: string): string {
  return `idem:v1:${route}:${createHash("sha256").update(idempotencyKey).digest("hex")}`;
}
