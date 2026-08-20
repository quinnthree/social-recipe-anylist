import { pathToFileURL } from "node:url";

import { config } from "dotenv";

import { importRecipe } from "./app/import-service.js";

// quiet: keep stdout to the recipe JSON / success line alone.
config({ quiet: true });

const USAGE = 'Usage: npm run import -- "<instagram-or-tiktok-url>" [--dry-run]';

export interface CliArgs {
  url: string;
  dryRun: boolean;
}

/** Accepts --dry-run before or after the URL. Unknown flags are rejected, never ignored. */
export function parseArgs(argv: readonly string[]): CliArgs {
  let url: string | null = null;
  let dryRun = false;

  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag "${arg}".\n${USAGE}`);
    } else if (url !== null) {
      throw new Error(`Expected a single URL but got two: "${url}" and "${arg}".\n${USAGE}`);
    } else {
      url = arg;
    }
  }

  if (url === null || url.trim().length === 0) {
    throw new Error(`No URL provided.\n${USAGE}`);
  }

  return { url: url.trim(), dryRun };
}

async function main(): Promise<void> {
  const { url, dryRun } = parseArgs(process.argv.slice(2));
  const { recipe, saved } = await importRecipe(url, { dryRun });

  // Dry run prints the Recipe JSON; a real run prints the success line only
  // after AnyList has verified the save.
  console.log(saved === null ? JSON.stringify(recipe, null, 2) : `✓ ${saved.name} saved to AnyList`);
}

/** Only run when invoked as the CLI, so tests can import parseArgs safely. */
const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
