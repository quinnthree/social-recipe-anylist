import { LazyIdempotencyStore } from "../idempotency/lazy-store.js";
import { MemoryIdempotencyStore } from "../idempotency/memory-store.js";
import { RedisIdempotencyStore } from "../idempotency/redis-store.js";
import type { IdempotencyStore } from "../idempotency/store.js";

const DEFAULT_PORT = 3000;

/**
 * Deployment decisions, kept out of the entrypoint.
 *
 * `src/server.ts` calls `listen()` at module load — that call is how Vercel
 * detects the HTTP server — so it cannot be imported by a test without opening
 * a port. Everything here is a pure function of the environment, which is the
 * part worth testing.
 */

/**
 * Vercel proxies to the captured server over an internal port, so a deployed
 * process must not bind loopback only. Locally the default is unchanged:
 * exposing a development server on every interface is not something anyone
 * asked for.
 */
export function resolveHost(env: NodeJS.ProcessEnv): string {
  const explicit = env["HOST"]?.trim();
  if (explicit) return explicit;

  return env["VERCEL"] ? "0.0.0.0" : "127.0.0.1";
}

export function resolvePort(env: NodeJS.ProcessEnv): number {
  const port = Number(env["PORT"] ?? DEFAULT_PORT);
  return Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT;
}

/**
 * Both namings are accepted because the Vercel Marketplace integration has used
 * each of them; whichever pair is injected works without a code change.
 */
export function hasRedisConfiguration(env: NodeJS.ProcessEnv): boolean {
  const url = env["KV_REST_API_URL"] ?? env["UPSTASH_REDIS_REST_URL"];
  const token = env["KV_REST_API_TOKEN"] ?? env["UPSTASH_REDIS_REST_TOKEN"];

  return Boolean(url && token);
}

export const REDIS_REQUIRED =
  "Upstash Redis is not configured. Refusing to deploy an export endpoint whose " +
  "idempotency store would be lost on restart. Set KV_REST_API_URL and KV_REST_API_TOKEN.";

export const MEMORY_STORE_WARNING =
  "Idempotency is using an in-process store. Fine locally; never acceptable deployed, " +
  "because it is lost on restart and invisible to other instances.";

/**
 * Chooses the idempotency store, and refuses to deploy without a durable one.
 *
 * An in-process store on Vercel is worse than none: it is lost on restart and
 * invisible to other instances, and because Fluid compute reuses instances it
 * would appear to work in every manual test before failing on the first
 * scale-out — presenting a duplicate-prevention guarantee it cannot keep
 * (ADR-012). Locally it is exactly the right thing, so the fallback is scoped
 * to "not deployed" rather than left to a flag someone can forget to set.
 *
 * Configuration is validated now; the client is built on first use, so the
 * process starts listening without waiting on it.
 */
export function resolveIdempotencyStore(
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void = console.warn,
): IdempotencyStore {
  if (hasRedisConfiguration(env)) {
    return new LazyIdempotencyStore(() => RedisIdempotencyStore.fromEnvironment(env));
  }

  if (env["VERCEL"]) throw new Error(REDIS_REQUIRED);

  warn(MEMORY_STORE_WARNING);

  return new MemoryIdempotencyStore();
}
