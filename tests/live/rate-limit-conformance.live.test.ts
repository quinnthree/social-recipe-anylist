import { describe } from "vitest";

import { requireLiveUpstash } from "./prerequisites.js";

import { RedisRateLimitStore } from "../../src/ratelimit/redis-store.js";
import { runRateLimitStoreConformance } from "../production/rate-limit-contract.js";

/**
 * LIVE EXTERNAL. Runs the counter conformance suite against real Upstash Redis.
 *
 * Skipped unless `QA_LIVE_EXTERNAL=1` is set, for the same reason as the other
 * live suites: a developer's `.env` may carry working credentials, and the
 * normal suite must stay offline regardless.
 *
 * With the flag set and credentials absent, this **fails** rather than skipping.
 * `QA_LIVE_EXTERNAL=1` means run or fail, never run if convenient.
 *
 *   QA_LIVE_EXTERNAL=1 npm test -- tests/live/
 *
 * This is the check that catches the Lua script diverging from the in-process
 * store. Atomicity is the property that cannot be verified any other way, and
 * it is the whole of what a rate limit is: `MemoryRateLimitStore` gets it
 * structurally from the event loop, Redis has to buy it with a script, and only
 * one of those runs in production.
 *
 * **This must be run and reported before M5E-B4 deployment approval**, together
 * with the credential-store live suite. Passing in-process is not evidence
 * about the store that guards a public credential mint.
 *
 * It writes real keys, namespaced `ratelimit:v1:` with a fresh subject per
 * case, and every one carries its window's TTL.
 */

// Throws rather than skips when the flag is set and Upstash is not
// configured: `QA_LIVE_EXTERNAL=1` is a request to run, and a suite that
// quietly declines it reports a pass for work that never happened.
const ENABLED = requireLiveUpstash();

describe.skipIf(!ENABLED)("upstash redis — rate limit conformance (LIVE)", () => {
  runRateLimitStoreConformance({
    createStore: () => RedisRateLimitStore.fromEnvironment(),
  });
});
