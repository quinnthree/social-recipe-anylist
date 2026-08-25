import {
  limitKey,
  type ConsumeResult,
  type LimitDescriptor,
  type RateLimitStore,
} from "./store.js";

/** The slice of a Redis client this store drives. */
export interface RedisLike {
  eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown>;
}

/**
 * Check every limit, then charge every limit — as one indivisible step.
 *
 * Two properties depend on this being one script rather than a sequence of
 * calls. Concurrent requests cannot both read "under the limit" and both
 * charge, which is the whole point of a limit. And a request refused by the
 * third descriptor is not charged against the first two, so a caller is never
 * penalised for a request that was never served.
 *
 * `EXPIRE` is set only when the counter is created. Refreshing it on every
 * increment would make a busy subject's window slide forward indefinitely and
 * the counter would never reset.
 *
 * Arguments are (limit, ttl) pairs, positionally matched to KEYS.
 */
export const CONSUME_SCRIPT = `
local count = #KEYS

for i = 1, count do
  local limit = tonumber(ARGV[i * 2 - 1])
  local current = tonumber(redis.call('GET', KEYS[i]) or '0')
  if current >= limit then
    return i
  end
end

for i = 1, count do
  local ttl = tonumber(ARGV[i * 2])
  if redis.call('INCR', KEYS[i]) == 1 then
    redis.call('EXPIRE', KEYS[i], ttl)
  end
end

return 0
`;

export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: RedisLike) {}

  /**
   * Builds a store from the environment, importing `@upstash/redis` lazily and
   * accepting either variable naming, as the other stores do.
   */
  static async fromEnvironment(env: NodeJS.ProcessEnv = process.env): Promise<RedisRateLimitStore> {
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

    return new RedisRateLimitStore({
      eval: (script, keys, args) => client.eval(script, keys, args),
    });
  }

  async consume(descriptors: readonly LimitDescriptor[], now: number): Promise<ConsumeResult> {
    if (descriptors.length === 0) return { allowed: true, exceeded: null };

    const keys = descriptors.map((descriptor) => limitKey(descriptor, now));
    const args = descriptors.flatMap((descriptor) => [
      descriptor.limit,
      descriptor.windowSeconds,
    ]);

    const raw = await this.redis.eval(CONSUME_SCRIPT, keys, args);

    // The type is checked before the coercion, not after: `Number(null)` is 0,
    // and 0 is the reply that means "allowed". A missing answer must never
    // read as permission.
    const reply = typeof raw === "number" || typeof raw === "string" ? Number(raw) : NaN;

    if (!Number.isInteger(reply) || reply < 0 || reply > descriptors.length) {
      // An unreadable reply is not evidence that the request was permitted.
      // The caller's catch turns this into a refusal.
      throw new Error("Rate limit store returned an unusable reply");
    }

    if (reply === 0) return { allowed: true, exceeded: null };

    return { allowed: false, exceeded: descriptors[reply - 1] ?? null };
  }
}
