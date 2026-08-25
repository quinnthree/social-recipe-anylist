import { afterAll, describe } from "vitest";

import { requireLiveUpstash } from "./prerequisites.js";

import { RedisIdempotencyStore } from "../../src/idempotency/redis-store.js";
import { RETENTION_SECONDS } from "../../src/idempotency/store.js";
import { runIdempotencyStoreConformance } from "../production/idempotency-contract.js";
import { deleteRecordedTestKeys, IsolatedIdempotencyStore } from "./isolated-store.js";

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
 * It writes real keys, and they are **not** in the application's namespace.
 * The suite reasons in logical keys (`k1`, `k2`, `k3`) and the store uses what
 * it is given verbatim, so without a wrapper those would be top-level keys
 * shared by every test and every run — which is exactly what M5E-B4 hit. Each
 * store instance therefore maps its keys under `idemtest:v1:<uuid>:`, unique
 * per test, and the exact keys created are deleted afterwards.
 */

// Throws rather than skips when the flag is set and Upstash is not
// configured: `QA_LIVE_EXTERNAL=1` is a request to run, and a suite that
// quietly declines it reports a pass for work that never happened.
const ENABLED = requireLiveUpstash();

describe.skipIf(!ENABLED)("upstash redis — idempotency conformance (LIVE)", () => {
  // Cleanup runs after the assertions, so it cannot affect what was measured,
  // and it removes only keys this process created.
  afterAll(async () => {
    await deleteRecordedTestKeys();
  });

  runIdempotencyStoreConformance({
    // A fresh namespace per store, and the suite builds one per test.
    createStore: async () =>
      new IsolatedIdempotencyStore(await RedisIdempotencyStore.fromEnvironment()),
    completedRetentionMs: RETENTION_SECONDS.COMPLETED * 1000,
    ambiguousRetentionMs: RETENTION_SECONDS.AMBIGUOUS * 1000,
  });
});
