import { describe } from "vitest";

import { RedisClientCredentialStore } from "../../src/client/redis-store.js";
import { runClientCredentialStoreConformance } from "../production/client-credential-contract.js";

/**
 * LIVE EXTERNAL. Runs the credential-store conformance suite against real
 * Upstash Redis.
 *
 * Skipped unless `QA_LIVE_EXTERNAL=1` is set *and* credentials are present.
 * Gating on the flag as well as the credentials is deliberate: a developer's
 * `.env` may well carry working Upstash credentials, and the normal suite must
 * stay offline regardless of what happens to be in the environment.
 *
 *   QA_LIVE_EXTERNAL=1 npm test -- tests/live/
 *
 * This is the check that catches the Redis implementation diverging from the
 * in-process one. Atomicity is the property that cannot be verified any other
 * way: `MemoryClientCredentialStore` gets it structurally from the event loop,
 * while Redis has to buy it with Lua, and only one of those runs in production.
 *
 * **This must be run and reported before M5E-B4 deployment approval.** Passing
 * the in-process suite is not evidence about the store that will actually be
 * deployed.
 *
 * It writes real keys, namespaced `client:v1:` with freshly minted ids per
 * case. Records the suite does not delete carry the contract's seven-day unused
 * window and age out on their own, because nothing here ever authenticates
 * them.
 */

const CREDENTIALS_PRESENT =
  (process.env["KV_REST_API_URL"] ?? process.env["UPSTASH_REDIS_REST_URL"]) !== undefined &&
  (process.env["KV_REST_API_TOKEN"] ?? process.env["UPSTASH_REDIS_REST_TOKEN"]) !== undefined;

const ENABLED = process.env["QA_LIVE_EXTERNAL"] === "1" && CREDENTIALS_PRESENT;

describe.skipIf(!ENABLED)("upstash redis — client credential conformance (LIVE)", () => {
  runClientCredentialStoreConformance({
    createStore: () => RedisClientCredentialStore.fromEnvironment(),
  });
});
