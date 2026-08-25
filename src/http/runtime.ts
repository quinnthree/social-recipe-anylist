import { config as loadEnvFile } from "dotenv";
import type { FastifyInstance } from "fastify";

import { LazyClientCredentialStore } from "../client/lazy-store.js";
import { RedisClientCredentialStore } from "../client/redis-store.js";
import type { ClientCredentialStore } from "../client/store.js";
import { LazyIdempotencyStore } from "../idempotency/lazy-store.js";
import { MemoryIdempotencyStore } from "../idempotency/memory-store.js";
import { RedisIdempotencyStore } from "../idempotency/redis-store.js";
import type { IdempotencyStore } from "../idempotency/store.js";
import { buildServer } from "./server.js";

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
  return redisCredentialSource(env) !== null;
}

/**
 * Which variable pair supplied the credentials — names only, never values.
 *
 * Logged once at startup so "is Redis actually wired up in this environment"
 * is answerable from the deployment log instead of by inference. The two pairs
 * are read per variable, so a mixed set still resolves; the label reports the
 * pair that supplied the URL.
 */
export function redisCredentialSource(
  env: NodeJS.ProcessEnv,
): "KV_REST_API_*" | "UPSTASH_REDIS_REST_*" | null {
  if (env["KV_REST_API_URL"] && env["KV_REST_API_TOKEN"]) return "KV_REST_API_*";
  if (env["UPSTASH_REDIS_REST_URL"] && env["UPSTASH_REDIS_REST_TOKEN"]) {
    return "UPSTASH_REDIS_REST_*";
  }

  return null;
}

export const REDIS_REQUIRED =
  "Upstash Redis is not configured. Refusing to deploy an export endpoint whose " +
  "idempotency store would be lost on restart. Set either " +
  "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN, or " +
  "KV_REST_API_URL and KV_REST_API_TOKEN.";

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

/**
 * Consumer credentials, where this deployment offers consumer authentication.
 *
 * Returning `undefined` is not a degraded mode: an installation token is
 * *refused* without a store, never accepted. It simply means nothing here can
 * verify one, which is the correct state for a local run that has no Redis and
 * no consumer clients.
 *
 * There is deliberately no in-memory fallback. The idempotency store has one
 * because local development genuinely needs export idempotency to function;
 * an in-memory credential store would mint nothing, verify nothing, and lose
 * everything on restart, so it would only ever create the illusion of consumer
 * auth being wired up.
 */
export function resolveClientCredentialStore(
  env: NodeJS.ProcessEnv,
): ClientCredentialStore | undefined {
  if (!hasRedisConfiguration(env)) return undefined;

  return new LazyClientCredentialStore(() => RedisClientCredentialStore.fromEnvironment(env));
}

/**
 * Builds the configured Fastify instance, without listening.
 *
 * Both entrypoints go through here so neither restates the wiring:
 * `./server.ts` builds and then listens for local use, and `../app.ts` builds
 * and exports a request handler for Vercel. Listening is the difference
 * between them, and it is deliberately not done here.
 */
export function createServer(env: NodeJS.ProcessEnv = process.env): FastifyInstance {
  loadEnvFile({ quiet: true });

  const instance = buildServer({
    apiKey: env["RECIPE_API_KEY"],
    idempotencyStore: resolveIdempotencyStore(env),
    clientStore: resolveClientCredentialStore(env),
    logger: true,
  });

  instance.log.info(
    { event: "idempotency.store_selected", source: redisCredentialSource(env) ?? "in-process" },
    "idempotency store selected",
  );

  return instance;
}
