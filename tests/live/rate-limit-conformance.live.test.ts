import { describe } from "vitest";

import { RedisRateLimitStore } from "../../src/ratelimit/redis-store.js";
import { runRateLimitStoreConformance } from "../production/rate-limit-contract.js";

/**
 * LIVE EXTERNAL. Runs the counter conformance suite against real Upstash Redis.
 *
 * Skipped unless `QA_LIVE_EXTERNAL=1` is set *and* credentials are present, for
 * the same reason as the other live suites: a developer's `.env` may carry
 * working credentials, and the normal suite must stay offline regardless.
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

const CREDENTIALS_PRESENT =
  (process.env["KV_REST_API_URL"] ?? process.env["UPSTASH_REDIS_REST_URL"]) !== undefined &&
  (process.env["KV_REST_API_TOKEN"] ?? process.env["UPSTASH_REDIS_REST_TOKEN"]) !== undefined;

const ENABLED = process.env["QA_LIVE_EXTERNAL"] === "1" && CREDENTIALS_PRESENT;

describe.skipIf(!ENABLED)("upstash redis — rate limit conformance (LIVE)", () => {
  runRateLimitStoreConformance({
    createStore: () => RedisRateLimitStore.fromEnvironment(),
  });
});
