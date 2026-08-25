import { describe } from "vitest";

import { requireLiveUpstash } from "./prerequisites.js";

import { RedisIdempotencyStore } from "../../src/idempotency/redis-store.js";
import { RETENTION_SECONDS } from "../../src/idempotency/store.js";
import { runIdempotencyStoreConformance } from "../production/idempotency-contract.js";

/**
 * LIVE EXTERNAL. Runs the idempotency conformance suite against real Upstash
 * Redis.
 *
 * Skipped unless `QA_LIVE_EXTERNAL=1` is set. Gating on the flag is deliberate:
 * a developer's `.env` may well carry working Upstash credentials, and the
 * normal suite must stay offline regardless of what is in the environment.
 *
 * With the flag set and credentials absent, this **fails** rather than skipping.
 * `QA_LIVE_EXTERNAL=1` means run or fail, never run if convenient.
 *
 *   QA_LIVE_EXTERNAL=1 npm test -- tests/live/
 *
 * This is the check that catches the Redis implementation diverging from the
 * in-process one. Atomic claim is the property that cannot be verified any
 * other way: `MemoryIdempotencyStore` gets it structurally from the event loop,
 * while Redis has to buy it with a Lua script, and only one of those is what
 * runs in production.
 *
 * It writes real keys. They are namespaced (`idem:v1:…`) and carry the
 * contract's own TTLs, so they age out on their own.
 */

// Throws rather than skips when the flag is set and Upstash is not
// configured: `QA_LIVE_EXTERNAL=1` is a request to run, and a suite that
// quietly declines it reports a pass for work that never happened.
const ENABLED = requireLiveUpstash();

describe.skipIf(!ENABLED)("upstash redis — idempotency conformance (LIVE)", () => {
  runIdempotencyStoreConformance({
    createStore: () => RedisIdempotencyStore.fromEnvironment(),
    completedRetentionMs: RETENTION_SECONDS.COMPLETED * 1000,
    ambiguousRetentionMs: RETENTION_SECONDS.AMBIGUOUS * 1000,
  });
});
