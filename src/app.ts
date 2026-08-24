import type { FastifyInstance } from "fastify";

import { server } from "./server.js";

/**
 * The Vercel deployment entrypoint.
 *
 * ## Why this file imports `fastify`
 *
 * Vercel does not choose a Fastify entrypoint by filename alone. `@vercel/fastify`
 * globs the candidates `app`, `index`, `server`, `src/app`, `src/index`,
 * `src/server` (× `js,cjs,mjs,ts,cts,mts`), **reads each one**, and takes the
 * first whose text matches:
 *
 *     /(?:from|require|import)\s*(?:\(\s*)?["']fastify["']\s*(?:\))?/g
 *
 * If nothing matches, no Fastify entrypoint is found: the build falls back to a
 * generic Node project, which then expects an `api/` directory that this
 * repository deliberately does not have. Our Fastify instance is constructed in
 * `./http/server.ts`, so without the import below **no candidate file mentions
 * Fastify at all** and the deployment cannot come up.
 *
 * The import is therefore load-bearing, not decorative — and it is not merely a
 * marker: the annotation on `app` fails to compile if `./server.ts` ever stops
 * producing a Fastify instance. `src/http/runtime.test.ts` pins the rule with
 * Vercel's own regex, so deleting this import as "unused" fails the suite
 * rather than the deploy.
 *
 * ## Why the entrypoint is here rather than in `./server.ts`
 *
 * Exactly one candidate must match, or the builder warns about multiple
 * entrypoints and the choice depends on a list order we do not control.
 * `src/index.ts` is the CLI and never calls `listen()`, so it must never be
 * selected; this file matching, and only this file, removes the ambiguity.
 */

/**
 * Read by `@vercel/node` via `@vercel/static-config`, which parses this exact
 * file. It must stay an object literal — the value is extracted statically, not
 * evaluated.
 *
 * This is the only supported place to set the duration for a framework-detected
 * backend: a `functions` entry in `vercel.json` is validated against Serverless
 * Functions in `api/`, matches nothing here, and fails the build.
 */
export const config = { maxDuration: 120 };

/** The running Fastify instance. Started by importing `./server.js`. */
export const app: Promise<FastifyInstance> = server;
