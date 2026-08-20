import { config } from "dotenv";

import { buildServer } from "./http/server.js";

config({ quiet: true });

const DEFAULT_PORT = 3000;
// Local only for this milestone. Exposing the API is a deliberate later step.
const HOST = process.env["HOST"] ?? "127.0.0.1";
const PORT = Number(process.env["PORT"] ?? DEFAULT_PORT);

async function main(): Promise<void> {
  const server = buildServer({ apiKey: process.env["RECIPE_API_KEY"], logger: true });

  await server.listen({ host: HOST, port: PORT });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
