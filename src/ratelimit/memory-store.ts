import {
  limitKey,
  type ConsumeResult,
  type LimitDescriptor,
  type RateLimitStore,
} from "./store.js";

interface Counter {
  count: number;
  expiresAt: number;
}

/**
 * An in-process `RateLimitStore` for tests and local development.
 *
 * Lost on restart and invisible to other instances, exactly like the in-process
 * idempotency store, and unacceptable in production for the same reason: it
 * would present a limit it cannot keep. It is held to the same semantics as the
 * Redis implementation so one set of tests covers both.
 *
 * Atomicity is structural — `consume` contains no `await`, so the event loop
 * cannot interleave two of them.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly counters = new Map<string, Counter>();

  consume(descriptors: readonly LimitDescriptor[], now: number): Promise<ConsumeResult> {
    return Promise.resolve(this.consumeSync(descriptors, now));
  }

  private consumeSync(descriptors: readonly LimitDescriptor[], now: number): ConsumeResult {
    // Checked in full before anything is written, so a refusal charges nothing.
    for (const descriptor of descriptors) {
      const counter = this.live(limitKey(descriptor, now), now);

      if ((counter?.count ?? 0) >= descriptor.limit) {
        return { allowed: false, exceeded: descriptor };
      }
    }

    for (const descriptor of descriptors) {
      const key = limitKey(descriptor, now);
      const counter = this.live(key, now);

      if (counter === null) {
        // The first increment establishes the window. Later ones must not
        // extend it, or a busy subject would never see it reset.
        this.counters.set(key, { count: 1, expiresAt: now + descriptor.windowSeconds * 1000 });
      } else {
        counter.count += 1;
      }
    }

    return { allowed: true, exceeded: null };
  }

  private live(key: string, now: number): Counter | null {
    const counter = this.counters.get(key);
    if (counter === undefined) return null;

    if (now >= counter.expiresAt) {
      this.counters.delete(key);
      return null;
    }

    return counter;
  }
}
