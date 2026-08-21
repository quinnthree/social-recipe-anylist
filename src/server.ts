import { config } from "dotenv";

import { buildServer } from "./http/server.js";
import { resolveHost, resolveIdempotencyStore, resolvePort } from "./http/runtime.js";

config({ quiet: true });

/**
 * The HTTP entrypoint, for `npm run server` locally and for Vercel.
 *
 * `listen()` is called at module load and is not guarded behind an argv check:
 * Vercel detects the HTTP server from that call, and a guard would make
 * detection depend on how the file happened to be invoked. Everything that
 * benefits from being tested lives in `./http/runtime.js`, which can be
 * imported without opening a port.
 */
async function main(): Promise<void> {
  const server = buildServer({
    apiKey: process.env["RECIPE_API_KEY"],
    idempotencyStore: resolveIdempotencyStore(process.env),
    logger: true,
  });

  await server.listen({ host: resolveHost(process.env), port: resolvePort(process.env) });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
