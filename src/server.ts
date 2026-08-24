import { config } from "dotenv";

import { buildServer } from "./http/server.js";
import { resolveHost, resolveIdempotencyStore, resolvePort } from "./http/runtime.js";

config({ quiet: true });

/**
 * Starts the HTTP server for `npm run server` locally and for Vercel.
 *
 * `listen()` is called at module load and is not guarded behind an argv check:
 * Vercel detects the HTTP server from that call, and a guard would make
 * detection depend on how the file happened to be invoked. Everything that
 * benefits from being tested lives in `./http/runtime.js`, which can be
 * imported without opening a port.
 *
 * The instance is returned rather than discarded so `./app.ts` — the file
 * Vercel actually selects as the entrypoint — can expose it.
 */
async function main() {
  const server = buildServer({
    apiKey: process.env["RECIPE_API_KEY"],
    idempotencyStore: resolveIdempotencyStore(process.env),
    logger: true,
  });

  await server.listen({ host: resolveHost(process.env), port: resolvePort(process.env) });

  return server;
}

/**
 * Deliberately *not* annotated with an imported `FastifyInstance` type.
 *
 * Vercel picks its Fastify entrypoint by reading these candidate files and
 * taking the first whose text imports `fastify`. Naming the type here would
 * make this file a second match, which produces a "Multiple entrypoints found"
 * warning and puts entrypoint selection at the mercy of a list order we do not
 * control. The type is inferred from `buildServer`, so nothing is lost.
 */
export const server = main();

server.catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
