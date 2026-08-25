import {
  clientKey,
  LAST_SEEN_REFRESH_MS,
  UNUSED_CREDENTIAL_TTL_SECONDS,
  type ClientCredential,
  type ClientCredentialStore,
  type CleanupResult,
  type CreateResult,
  type NewClientCredential,
  type RevokeResult,
  type TouchResult,
} from "./store.js";

/**
 * The slice of a Redis client this store drives.
 *
 * Structural rather than a concrete import, mirroring the idempotency store, so
 * tests exercise the real dispatch logic against a stub and `@upstash/redis` is
 * only loaded when a store is actually built.
 */
export interface RedisLike {
  eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, unknown> | null>;
}

/**
 * Create, or report that the id is taken — in one round trip.
 *
 * Read-then-write in application code would let two concurrent creates for the
 * same id both see "absent" and both write, and the loser's credential would be
 * silently revoked by the winner's overwrite. A collision is cryptographically
 * improbable; handling it is cheap, and "improbable" is not a guarantee.
 *
 * The TTL applies only until the credential first authenticates. `TOUCH_SCRIPT`
 * removes it.
 */
export const CREATE_SCRIPT = `
local key = KEYS[1]
local secretHash = ARGV[1]
local createdAt = ARGV[2]
local unusedTtl = tonumber(ARGV[3])

if redis.call('EXISTS', key) == 1 then
  return 'exists'
end

redis.call('HSET', key,
  'secretHash', secretHash,
  'status', 'active',
  'createdAt', createdAt)
redis.call('EXPIRE', key, unusedTtl)

return 'created'
`;

/**
 * Record a successful authentication.
 *
 * Three properties live here rather than in the caller, because only the store
 * can hold them together:
 *
 * 1. A revoked record is never touched back into activity. Revocation has to
 *    survive concurrent in-flight requests that were authorised a moment
 *    earlier.
 * 2. The first write calls `PERSIST`. That is what makes a credential durable,
 *    and it is the moment it stops being an orphan.
 * 3. Later writes are skipped while `lastSeenAt` is fresh, so the hot path
 *    stays at one round trip.
 */
export const TOUCH_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local refreshAfterMs = tonumber(ARGV[2])

local status = redis.call('HGET', key, 'status')
if not status then return 'missing' end
if status == 'revoked' then return 'revoked' end

local lastSeenAt = redis.call('HGET', key, 'lastSeenAt')
if lastSeenAt and (now - tonumber(lastSeenAt)) < refreshAfterMs then
  return 'skipped'
end

redis.call('HSET', key, 'lastSeenAt', string.format('%d', now))
redis.call('PERSIST', key)

return 'recorded'
`;

/**
 * Revoke without deleting.
 *
 * Retention is left alone deliberately: a credential that was never used still
 * ages out, and one that was used stays durable. Revocation changes what the
 * record says, not how long it is kept.
 */
export const REVOKE_SCRIPT = `
local key = KEYS[1]
local now = ARGV[1]

local status = redis.call('HGET', key, 'status')
if not status then return 'missing' end
if status == 'revoked' then return 'already_revoked' end

redis.call('HSET', key, 'status', 'revoked', 'revokedAt', now)

return 'revoked'
`;

/**
 * Delete only a credential that never authenticated and is old enough.
 *
 * Both conditions are checked inside the script. Checking them in application
 * code would let a credential that authenticates between the read and the
 * delete be removed while in use.
 */
export const CLEANUP_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local olderThanMs = tonumber(ARGV[2])

local createdAt = redis.call('HGET', key, 'createdAt')
if not createdAt then return 'missing' end

if redis.call('HGET', key, 'lastSeenAt') then return 'in_use' end
if (now - tonumber(createdAt)) < olderThanMs then return 'too_recent' end

redis.call('DEL', key)

return 'deleted'
`;

export class RedisClientCredentialStore implements ClientCredentialStore {
  constructor(private readonly redis: RedisLike) {}

  /**
   * Builds a store from the environment, importing `@upstash/redis` lazily and
   * accepting either variable naming, exactly as the idempotency store does.
   */
  static async fromEnvironment(
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<RedisClientCredentialStore> {
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

    return new RedisClientCredentialStore({
      eval: (script, keys, args) => client.eval(script, keys, args),
      hgetall: (key) => client.hgetall(key),
    });
  }

  async create({ clientId, secretHash, createdAt }: NewClientCredential): Promise<CreateResult> {
    const reply = await this.redis.eval(
      CREATE_SCRIPT,
      [clientKey(clientId)],
      [secretHash, String(createdAt), UNUSED_CREDENTIAL_TTL_SECONDS],
    );

    // An unrecognised reply reads as "taken". Refusing to believe we created a
    // record is the safe direction: the caller mints another id.
    return reply === "created" ? "created" : "exists";
  }

  async read(clientId: string): Promise<ClientCredential | null> {
    const raw = await this.redis.hgetall(clientKey(clientId));
    if (raw === null || raw["status"] === undefined) return null;

    return {
      clientId,
      secretHash: String(raw["secretHash"] ?? ""),
      status: raw["status"] === "revoked" ? "revoked" : "active",
      createdAt: Number(raw["createdAt"] ?? 0),
      lastSeenAt: optionalNumber(raw["lastSeenAt"]),
      revokedAt: optionalNumber(raw["revokedAt"]),
    };
  }

  async touch(
    clientId: string,
    now: number,
    refreshAfterMs: number = LAST_SEEN_REFRESH_MS,
  ): Promise<TouchResult> {
    const reply = await this.redis.eval(
      TOUCH_SCRIPT,
      [clientKey(clientId)],
      [now, refreshAfterMs],
    );

    switch (reply) {
      case "recorded":
        return "recorded";
      case "skipped":
        return "skipped";
      case "revoked":
        return "revoked";
      default:
        return "missing";
    }
  }

  async revoke(clientId: string, now: number): Promise<RevokeResult> {
    const reply = await this.redis.eval(REVOKE_SCRIPT, [clientKey(clientId)], [String(now)]);

    switch (reply) {
      case "revoked":
        return "revoked";
      case "already_revoked":
        return "already_revoked";
      default:
        return "missing";
    }
  }

  async deleteIfUnused(
    clientId: string,
    now: number,
    olderThanMs: number = UNUSED_CREDENTIAL_TTL_SECONDS * 1000,
  ): Promise<CleanupResult> {
    const reply = await this.redis.eval(
      CLEANUP_SCRIPT,
      [clientKey(clientId)],
      [now, olderThanMs],
    );

    switch (reply) {
      case "deleted":
        return "deleted";
      case "in_use":
        return "in_use";
      case "too_recent":
        return "too_recent";
      default:
        return "missing";
    }
  }
}

/**
 * Upstash returns hash fields as strings or, where they look numeric, as
 * numbers. Both are accepted; anything else reads as absent rather than as a
 * timestamp of `NaN`.
 */
function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}
