/**
 * Fixed-window counters for rate limits and quotas (ADR-027).
 *
 * Deliberately separate from `ClientCredentialStore`. Credentials are durable
 * records with hashes and revocation, written rarely; counters are disposable
 * integers written on every request. Sharing an interface would mean one
 * abstraction serving two access patterns, and the credential store would
 * inherit a write volume it has no reason to carry.
 */

export interface LimitDescriptor {
  /** What is being limited, e.g. `register:ip` or `imports:client`. */
  scope: string;
  /** Who it is being limited for — an address, a clientId, or `global`. */
  subject: string;
  limit: number;
  windowSeconds: number;
}

export interface ConsumeResult {
  allowed: boolean;
  /** The descriptor that refused, when one did. For telemetry, never for the client. */
  exceeded: LimitDescriptor | null;
}

export interface RateLimitStore {
  /**
   * Consume one unit against **every** descriptor, or none of them.
   *
   * All-or-nothing matters: registration is governed by three limits at once,
   * and charging the hourly bucket for a request the daily bucket is about to
   * refuse would penalise a caller for a request that never happened.
   *
   * A refused request must not be charged. That rules out the usual
   * increment-then-compare, so implementations check and increment as one
   * indivisible step — which is also what keeps concurrent requests from
   * undercounting.
   */
  consume(descriptors: readonly LimitDescriptor[], now: number): Promise<ConsumeResult>;
}

/**
 * Fixed windows, keyed by the window they fall in.
 *
 * The window index is part of the key, so expiry is a cleanup detail rather
 * than a correctness one: a counter that outlives its window is simply never
 * read again. Sliding windows would need either a sorted set per subject or
 * arithmetic across two keys, and neither buys anything at these limits.
 */
export function limitKey(descriptor: LimitDescriptor, now: number): string {
  const window = Math.floor(now / (descriptor.windowSeconds * 1000));

  return `ratelimit:v1:${descriptor.scope}:${descriptor.subject}:${window}`;
}
