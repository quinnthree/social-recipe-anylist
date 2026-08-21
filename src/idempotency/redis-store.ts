import {
  RETENTION_SECONDS,
  type ClaimRequest,
  type ClaimResult,
  type IdempotencyRecord,
  type IdempotencyStore,
  type StoredResult,
} from "./store.js";

/**
 * The slice of a Redis client this store drives.
 *
 * Structural rather than a concrete import, so tests can exercise the real
 * script-dispatch logic against a stub, and so `@upstash/redis` is only loaded
 * when a store is actually built.
 */
export interface RedisLike {
  eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, unknown> | null>;
}

/**
 * Resolve a claim and, where the state permits, take it — in **one** round
 * trip.
 *
 * Every branch has to be inside the script. Doing this as read-then-write in
 * application code would let two concurrent same-key requests both read
 * "unseen" and both claim, which is the exact failure the whole mechanism
 * exists to prevent. Note that the `FAILED_SAFE` re-claim (branch 5) is a claim
 * too — it is easy to overlook, and leaving it outside the atomic step would
 * let two concurrent retries of a safely-failed export both proceed.
 *
 * The stale-lease branch converts the record rather than deleting it. Record
 * TTL preserves the record; `leaseExpiresAt` says whether anyone is still
 * working on it. Collapsing the two would let a key return to unseen by ageing,
 * and a second AnyList write would happen solely because time passed.
 */
export const CLAIM_SCRIPT = `
local key = KEYS[1]
local fingerprint = ARGV[1]
local requestId = ARGV[2]
local now = tonumber(ARGV[3])
local leaseMs = tonumber(ARGV[4])
local inProgressTtl = tonumber(ARGV[5])
local ambiguousTtl = tonumber(ARGV[6])

local state = redis.call('HGET', key, 'state')

if not state then
  redis.call('HSET', key,
    'state', 'IN_PROGRESS',
    'fingerprint', fingerprint,
    'requestId', requestId,
    'leaseExpiresAt', string.format('%d', now + leaseMs),
    'createdAt', string.format('%d', now),
    'updatedAt', string.format('%d', now))
  redis.call('EXPIRE', key, inProgressTtl)
  return {'claimed'}
end

if redis.call('HGET', key, 'fingerprint') ~= fingerprint then
  return {'conflict'}
end

if state == 'COMPLETED' then
  local result = redis.call('HGET', key, 'result')
  if result then
    return {'completed', result, redis.call('HGET', key, 'requestId')}
  end
  return {'ambiguous'}
end

if state == 'AMBIGUOUS' then
  return {'ambiguous'}
end

if state == 'FAILED_SAFE' then
  redis.call('HSET', key,
    'state', 'IN_PROGRESS',
    'requestId', requestId,
    'leaseExpiresAt', string.format('%d', now + leaseMs),
    'updatedAt', string.format('%d', now))
  redis.call('HDEL', key, 'failureCode')
  redis.call('EXPIRE', key, inProgressTtl)
  return {'claimed'}
end

local lease = tonumber(redis.call('HGET', key, 'leaseExpiresAt'))
if lease and now <= lease then
  return {'in_progress'}
end

redis.call('HSET', key,
  'state', 'AMBIGUOUS',
  'failureCode', 'lease_expired',
  'updatedAt', string.format('%d', now))
redis.call('EXPIRE', key, ambiguousTtl)
return {'ambiguous'}
`;

/**
 * Both terminal transitions are guarded on still holding the claim.
 *
 * A request whose lease expired has already had its record converted to
 * `AMBIGUOUS`. Without this guard it could finish late and overwrite that
 * uncertainty with a confident answer that no client is waiting for — turning a
 * preserved unknown back into a claim we cannot support.
 */
export const SETTLE_SCRIPT = `
local key = KEYS[1]
local requestId = ARGV[1]
local state = ARGV[2]
local payload = ARGV[3]
local now = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

if redis.call('HGET', key, 'state') ~= 'IN_PROGRESS' then return 0 end
if redis.call('HGET', key, 'requestId') ~= requestId then return 0 end

if state == 'COMPLETED' then
  redis.call('HSET', key, 'state', state, 'result', payload, 'updatedAt', string.format('%d', now))
  redis.call('HDEL', key, 'failureCode')
else
  redis.call('HSET', key, 'state', state, 'failureCode', payload, 'updatedAt', string.format('%d', now))
end

redis.call('EXPIRE', key, ttl)
return 1
`;

export class RedisIdempotencyStore implements IdempotencyStore {
  constructor(private readonly redis: RedisLike) {}

  /**
   * Builds a store from the environment, importing `@upstash/redis` lazily so
   * nothing loads it on a path that never touches idempotency.
   *
   * Both variable namings are accepted because the Vercel Marketplace
   * integration has used each of them; whichever pair is injected will work
   * without a code change.
   */
  static async fromEnvironment(env: NodeJS.ProcessEnv = process.env): Promise<RedisIdempotencyStore> {
    const url = env["KV_REST_API_URL"] ?? env["UPSTASH_REDIS_REST_URL"];
    const token = env["KV_REST_API_TOKEN"] ?? env["UPSTASH_REDIS_REST_TOKEN"];

    if (!url || !token) {
      throw new Error(
        "Upstash Redis is not configured. Set KV_REST_API_URL and KV_REST_API_TOKEN " +
          "(or UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN).",
      );
    }

    const { Redis } = await import("@upstash/redis");
    const client = new Redis({ url, token });

    return new RedisIdempotencyStore({
      eval: (script, keys, args) => client.eval(script, keys, args),
      hgetall: (key) => client.hgetall(key),
    });
  }

  async claim({ key, fingerprint, requestId, now, leaseMs }: ClaimRequest): Promise<ClaimResult> {
    const reply = asArray(
      await this.redis.eval(CLAIM_SCRIPT, [key], [
        fingerprint,
        requestId,
        now,
        leaseMs,
        RETENTION_SECONDS.IN_PROGRESS,
        RETENTION_SECONDS.AMBIGUOUS,
      ]),
    );

    switch (reply[0]) {
      case "claimed":
        return { status: "claimed" };
      case "conflict":
        return { status: "conflict" };
      case "in_progress":
        return { status: "in_progress" };
      case "completed": {
        const result = parseResult(reply[1]);
        // A COMPLETED record with an unreadable result is a corrupted record,
        // not a successful export. Reporting it as unknown is the safe read.
        return result === null
          ? { status: "ambiguous" }
          : { status: "completed", result, originalRequestId: String(reply[2] ?? "") };
      }
      default:
        return { status: "ambiguous" };
    }
  }

  async complete(key: string, requestId: string, result: StoredResult, now: number): Promise<void> {
    await this.redis.eval(
      SETTLE_SCRIPT,
      [key],
      [requestId, "COMPLETED", JSON.stringify(result), now, RETENTION_SECONDS.COMPLETED],
    );
  }

  async fail(
    key: string,
    requestId: string,
    state: "FAILED_SAFE" | "AMBIGUOUS",
    failureCode: string,
    now: number,
  ): Promise<void> {
    await this.redis.eval(
      SETTLE_SCRIPT,
      [key],
      [requestId, state, failureCode, now, RETENTION_SECONDS[state]],
    );
  }

  async read(key: string): Promise<IdempotencyRecord | null> {
    const raw = await this.redis.hgetall(key);
    if (raw === null || raw["state"] === undefined) return null;

    return {
      state: String(raw["state"]) as IdempotencyRecord["state"],
      fingerprint: String(raw["fingerprint"] ?? ""),
      requestId: String(raw["requestId"] ?? ""),
      leaseExpiresAt: Number(raw["leaseExpiresAt"] ?? 0),
      result: parseResult(raw["result"]),
      failureCode: raw["failureCode"] === undefined ? null : String(raw["failureCode"]),
      createdAt: Number(raw["createdAt"] ?? 0),
      updatedAt: Number(raw["updatedAt"] ?? 0),
    };
  }
}

function asArray(reply: unknown): unknown[] {
  return Array.isArray(reply) ? reply : [reply];
}

/**
 * Upstash deserialises JSON-looking values automatically, so a stored result
 * can come back either as a string or as an already-parsed object. Both are
 * accepted; anything else reads as absent rather than throwing on a path where
 * a throw would be reported as an export failure.
 */
function parseResult(value: unknown): StoredResult | null {
  if (value === null || value === undefined) return null;

  const candidate = typeof value === "string" ? tryParse(value) : value;
  if (typeof candidate !== "object" || candidate === null) return null;

  const { id, name } = candidate as { id?: unknown; name?: unknown };
  if (typeof id !== "string" || typeof name !== "string") return null;

  return { id, name };
}

function tryParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
