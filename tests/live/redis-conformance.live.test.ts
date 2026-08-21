import { describe } from "vitest";

import { RedisIdempotencyStore } from "../../src/idempotency/redis-store.js";
import { RETENTION_SECONDS } from "../../src/idempotency/store.js";
import { runIdempotencyStoreConformance } from "../production/idempotency-contract.js";

/**
 * LIVE EXTERNAL. Runs the idempotency conformance suite against real Upstash
 * Redis.
 *
 * Skipped unless `QA_LIVE_EXTERNAL=1` is set *and* credentials are present.
 * Gating on the flag as well as the credentials is deliberate: a developer's
 * `.env` may well carry working Upstash credentials, and the normal suite must
 * stay offline regardless of what happens to be in the environment.
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

const CREDENTIALS_PRESENT =
  (process.env["KV_REST_API_URL"] ?? process.env["UPSTASH_REDIS_REST_URL"]) !== undefined &&
  (process.env["KV_REST_API_TOKEN"] ?? process.env["UPSTASH_REDIS_REST_TOKEN"]) !== undefined;

const ENABLED = process.env["QA_LIVE_EXTERNAL"] === "1" && CREDENTIALS_PRESENT;

describe.skipIf(!ENABLED)("upstash redis — idempotency conformance (LIVE)", () => {
  runIdempotencyStoreConformance({
    createStore: () => RedisIdempotencyStore.fromEnvironment(),
    completedRetentionMs: RETENTION_SECONDS.COMPLETED * 1000,
    ambiguousRetentionMs: RETENTION_SECONDS.AMBIGUOUS * 1000,
  });
});
