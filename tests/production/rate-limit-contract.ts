import { expect, it } from "vitest";

import type { LimitDescriptor, RateLimitStore } from "../../src/ratelimit/store.js";

/**
 * Fixed-window counter semantics (ADR-027), as a suite that runs against any
 * implementation — the in-process one in normal CI, real Upstash under the
 * live gate.
 *
 * Every case uses a fresh subject, so the suite is order-independent and safe
 * against a shared store.
 */

export interface RateLimitSuiteOptions {
  createStore: () => RateLimitStore | Promise<RateLimitStore>;
}

const MINUTE_SECONDS = 60;

let counter = 0;
function subject(): string {
  counter += 1;
  return `suite-${Date.now()}-${counter}-${Math.floor(Math.random() * 1e9)}`;
}

function rule(limit: number, windowSeconds = MINUTE_SECONDS): LimitDescriptor {
  return { scope: "test:suite", subject: subject(), limit, windowSeconds };
}

export function runRateLimitStoreConformance({ createStore }: RateLimitSuiteOptions): void {
  it("allows exactly up to the limit, then refuses", async () => {
    const store = await createStore();
    const descriptor = rule(3);
    const now = Date.now();

    for (let i = 0; i < 3; i += 1) {
      expect((await store.consume([descriptor], now)).allowed).toBe(true);
    }

    const refused = await store.consume([descriptor], now);
    expect(refused.allowed).toBe(false);
    expect(refused.exceeded?.scope).toBe(descriptor.scope);
  });

  it("charges nothing for a request it refuses", async () => {
    const store = await createStore();
    const tight = rule(1);
    const loose = rule(5);
    const now = Date.now();

    expect((await store.consume([tight, loose], now)).allowed).toBe(true);
    // Refused by `tight`. If `loose` were charged anyway, the caller would be
    // paying for a request that was never served.
    expect((await store.consume([tight, loose], now)).allowed).toBe(false);

    for (let i = 0; i < 4; i += 1) {
      expect((await store.consume([loose], now)).allowed).toBe(true);
    }

    expect((await store.consume([loose], now)).allowed).toBe(false);
  });

  it("is all-or-nothing across descriptors", async () => {
    const store = await createStore();
    const first = rule(2);
    const second = rule(2);
    const now = Date.now();

    await store.consume([first, second], now);
    await store.consume([first], now);

    // `first` is now full; the pair must refuse without charging `second`.
    expect((await store.consume([first, second], now)).allowed).toBe(false);
    expect((await store.consume([second], now)).allowed).toBe(true);
  });

  it("resets when the window rolls over", async () => {
    const store = await createStore();
    const descriptor = rule(1);
    const now = Date.now();

    expect((await store.consume([descriptor], now)).allowed).toBe(true);
    expect((await store.consume([descriptor], now)).allowed).toBe(false);
    expect((await store.consume([descriptor], now + MINUTE_SECONDS * 1000)).allowed).toBe(true);
  });

  it("does not let a late hit push the window forward", async () => {
    const store = await createStore();
    const descriptor = rule(2);
    const now = Date.now();

    await store.consume([descriptor], now);
    // A hit just before the boundary must not extend the window.
    await store.consume([descriptor], now + MINUTE_SECONDS * 1000 - 1);

    expect((await store.consume([descriptor], now + MINUTE_SECONDS * 1000)).allowed).toBe(true);
  });

  it("keeps subjects independent", async () => {
    const store = await createStore();
    const one = rule(1);
    const two = { ...one, subject: subject() };
    const now = Date.now();

    expect((await store.consume([one], now)).allowed).toBe(true);
    expect((await store.consume([one], now)).allowed).toBe(false);
    expect((await store.consume([two], now)).allowed).toBe(true);
  });

  it("keeps scopes independent for the same subject", async () => {
    const store = await createStore();
    const hour = rule(1);
    const day = { ...hour, scope: "test:suite:other" };
    const now = Date.now();

    expect((await store.consume([hour], now)).allowed).toBe(true);
    expect((await store.consume([day], now)).allowed).toBe(true);
  });

  it("does not undercount under concurrency", async () => {
    const store = await createStore();
    const descriptor = rule(5);
    const now = Date.now();

    const results = await Promise.all(
      Array.from({ length: 25 }, () => store.consume([descriptor], now)),
    );

    // The property a limit is: never more than the limit, whatever the
    // interleaving.
    expect(results.filter((result) => result.allowed)).toHaveLength(5);
  });

  it("permits anything when asked about nothing", async () => {
    const store = await createStore();

    expect((await store.consume([], Date.now())).allowed).toBe(true);
  });
}
