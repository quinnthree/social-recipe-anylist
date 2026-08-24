import { createServer, resolveHost, resolvePort } from "./http/runtime.js";

/**
 * The local HTTP entrypoint, for `npm run server` and `npm run server:dev`.
 *
 * This is the only file that listens. Vercel is served by `./app.ts`, which
 * builds the same instance through `createServer()` and exports a request
 * handler instead — so there is exactly one `listen()` call in the codebase and
 * importing the Vercel entrypoint cannot open a second one.
 */
async function main() {
  const server = createServer();

  await server.listen({ host: resolveHost(process.env), port: resolvePort(process.env) });

  return server;
}

export const server = main();

server.catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
