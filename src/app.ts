import type { IncomingMessage, ServerResponse } from "node:http";

import type { FastifyInstance } from "fastify";

import { createServer } from "./http/runtime.js";

/**
 * The Vercel entrypoint.
 *
 * ## Why this file imports `fastify`
 *
 * `@vercel/fastify` does not pick an entrypoint by filename. It globs the
 * candidates `app`, `index`, `server`, `src/app`, `src/index`, `src/server`
 * (× `js,cjs,mjs,ts,cts,mts`), **reads each one**, and takes the first whose
 * text matches:
 *
 *     /(?:from|require|import)\s*(?:\(\s*)?["']fastify["']\s*(?:\))?/g
 *
 * Our instance is constructed in `./http/server.ts`, so without the import
 * below no candidate mentions Fastify and nothing is detected. The import is
 * load-bearing, and it is not just a marker: `instance` is annotated with it,
 * so the file stops compiling if `createServer()` ever returns something else.
 * `src/http/runtime.test.ts` pins the rule using Vercel's own regex.
 *
 * ## Why this file does not listen
 *
 * Vercel's launcher captures a server by monkey-patching
 * `http.Server.prototype.listen`, and that patch **swallows the first call** —
 * it records the instance and returns without binding. A Fastify `listen()`
 * racing that patch never sees its `listening` event, so the promise never
 * settles and every request hangs. Exporting a request handler avoids the race
 * completely: the launcher takes the function and never touches `listen`.
 *
 * `./server.ts` still listens, because that is what running locally needs.
 * Nothing imports it from here, so there is no second listener.
 */

/**
 * Read by `@vercel/node` through `@vercel/static-config`, which parses this
 * exact file. It must stay an object literal — the value is extracted
 * statically, never evaluated.
 *
 * This is the only supported place to set the duration for a
 * framework-detected backend: a `functions` entry in `vercel.json` is validated
 * against Serverless Functions in `api/` and fails the build.
 */
export const config = { maxDuration: 120 };

/**
 * Built once per instance, at module load, so route registration and the
 * durable-store check happen during cold start rather than on the first
 * request. A missing durable store on Vercel still throws here, exactly as
 * before.
 */
const instance: FastifyInstance = createServer();

/** Fastify must finish booting before `routing()` may be called. */
const ready = instance.ready();

/**
 * The shape Vercel's launcher accepts: a plain `(req, res)` handler.
 *
 * `routing()` is Fastify's public request entry point, so this dispatches
 * through the same router, hooks, and error handling that a listening server
 * would — no route logic is duplicated or bypassed.
 */
export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  await ready;

  instance.routing(request, response);
}
