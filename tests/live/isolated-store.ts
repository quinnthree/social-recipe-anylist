import { randomUUID } from "node:crypto";

import type {
  ClaimRequest,
  ClaimResult,
  IdempotencyRecord,
  IdempotencyStore,
  StoredResult,
} from "../../src/idempotency/store.js";

/**
 * Isolation for live idempotency conformance.
 *
 * The conformance suite reasons in logical keys — `k1`, `k2`, `k3` — and the
 * store uses whatever key it is given verbatim, because namespacing is the
 * route's job (`storeKey()` in `src/idempotency/store.ts`). Against the
 * in-process store that is harmless: every `createStore()` builds a fresh
 * `Map`, so each test starts empty. Against Redis it is not, because every
 * `createStore()` returns a new client pointed at the *same* database, and
 * `k1` is then one shared physical key across every test in the suite, every
 * repeat run, and every concurrent run.
 *
 * That is what M5E-B4 hit: a test claimed `k1` as `req-original`, read it back,
 * and found `req-1` left there by an earlier case.
 *
 * The fix is isolation by construction, not cleanup. Each store instance maps
 * its logical keys into a namespace unique to that instance, so no test can
 * observe another's record and nothing has to be deleted to make the next run
 * correct.
 *
 * **Nothing here touches production keys.** Application records live under
 * `idem:v1:…`; these live under `idemtest:v1:…`, a prefix no route can produce.
 */

/** Deliberately distinct from the application's `idem:v1:` family. */
export const TEST_KEY_PREFIX = "idemtest:v1:";

const touched = new Set<string>();

/** Physical keys this process has written, for exact-match cleanup. */
export function recordedTestKeys(): string[] {
  return [...touched];
}

export function forgetTestKeys(): void {
  touched.clear();
}

export function uniqueNamespace(): string {
  return randomUUID();
}

/**
 * Maps every logical key through a per-instance namespace.
 *
 * Deterministic within an instance, so the suite's own relationships still
 * hold: the same `k1` is the same record throughout one test, and `k1`, `k2`,
 * `k3` stay distinct.
 */
export class IsolatedIdempotencyStore implements IdempotencyStore {
  constructor(
    private readonly inner: IdempotencyStore,
    private readonly namespace: string = uniqueNamespace(),
  ) {}

  physicalKey(key: string): string {
    const physical = `${TEST_KEY_PREFIX}${this.namespace}:${key}`;
    touched.add(physical);

    return physical;
  }

  claim(request: ClaimRequest): Promise<ClaimResult> {
    return this.inner.claim({ ...request, key: this.physicalKey(request.key) });
  }

  complete(key: string, requestId: string, result: StoredResult, now: number): Promise<void> {
    return this.inner.complete(this.physicalKey(key), requestId, result, now);
  }

  fail(
    key: string,
    requestId: string,
    state: "FAILED_SAFE" | "AMBIGUOUS",
    failureCode: string,
    now: number,
  ): Promise<void> {
    return this.inner.fail(this.physicalKey(key), requestId, state, failureCode, now);
  }

  read(key: string): Promise<IdempotencyRecord | null> {
    return this.inner.read(this.physicalKey(key));
  }
}

/**
 * The real TTL Redis is holding for a test-owned key, in seconds.
 *
 * Redis answers -1 for a key with no expiry and -2 for one that does not
 * exist, and both are returned as-is: a record that never expires is a worse
 * failure than a short one, and flattening either to 0 would hide it.
 *
 * Test-owned keys only. Reading a production record's TTL would be harmless,
 * but the prefix check is what makes "this code never touches application
 * data" a property rather than an intention.
 */
export async function readTestKeyTtlSeconds(
  physicalKey: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (!physicalKey.startsWith(TEST_KEY_PREFIX)) {
    throw new Error(`Refusing to inspect ${physicalKey}: live tests read only their own keys.`);
  }

  const client = await upstashClient(env);
  if (client === null) throw new Error("Upstash is not configured.");

  return client.ttl(physicalKey);
}

/**
 * Removes exactly the keys this process created, and refuses anything else.
 *
 * Cleanup is a courtesy, not the isolation mechanism: the suite exercises
 * `AMBIGUOUS` and `IN_PROGRESS`, which carry thirty-day retention by contract
 * (ADR-025), and leaving those to accumulate in a real database on every run is
 * untidy. It runs after the assertions, so it cannot affect what was measured.
 *
 * The prefix check is a safety belt, not a formality. This code deletes from
 * the production Redis instance, and the one mistake that must be impossible is
 * deleting a real idempotency record — so a key that does not carry the test
 * prefix is refused rather than skipped, loudly.
 */
export async function deleteRecordedTestKeys(
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const keys = recordedTestKeys();
  if (keys.length === 0) return 0;

  const unexpected = keys.filter((key) => !key.startsWith(TEST_KEY_PREFIX));
  if (unexpected.length > 0) {
    throw new Error(
      `Refusing to delete ${unexpected.length} key(s) outside ${TEST_KEY_PREFIX}. ` +
        "Live cleanup may only remove keys it created.",
    );
  }

  const client = await upstashClient(env);
  if (client === null) return 0;

  await client.del(...keys);
  forgetTestKeys();

  return keys.length;
}

async function upstashClient(
  env: NodeJS.ProcessEnv,
): Promise<{ del(...keys: string[]): Promise<number>; ttl(key: string): Promise<number> } | null> {
  const url = env["KV_REST_API_URL"] ?? env["UPSTASH_REDIS_REST_URL"];
  const token = env["KV_REST_API_TOKEN"] ?? env["UPSTASH_REDIS_REST_TOKEN"];
  if (!url || !token) return null;

  const { Redis } = await import("@upstash/redis");

  return new Redis({ url, token });
}
