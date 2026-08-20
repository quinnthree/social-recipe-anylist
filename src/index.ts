import { pathToFileURL } from "node:url";

import { config } from "dotenv";

import { AnyListRecipeSaver } from "./anylist/client.js";
import type { RecipeSaver } from "./anylist/types.js";
import { parseRecipe } from "./recipe/parser.js";
import { fetchSourceContent } from "./social/index.js";

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

export interface ImportDeps {
  fetchSourceContent: typeof fetchSourceContent;
  parseRecipe: typeof parseRecipe;
  createSaver: () => RecipeSaver;
}

/** Runs the pipeline and returns what should be printed to stdout. */
export async function runImport(
  { url, dryRun }: CliArgs,
  { fetchSourceContent: fetchContent, parseRecipe: parse, createSaver }: ImportDeps,
): Promise<string> {
  const content = await fetchContent(url);
  const recipe = await parse(content);

  if (dryRun) {
    // createSaver is never called, so AnyList is never imported, constructed,
    // authenticated, or contacted.
    return JSON.stringify(recipe, null, 2);
  }

  const result = await createSaver().save(recipe);
  return `✓ ${result.name} saved to AnyList`;
}

async function main(): Promise<void> {
  const output = await runImport(parseArgs(process.argv.slice(2)), {
    fetchSourceContent,
    parseRecipe,
    createSaver: () => AnyListRecipeSaver.fromEnvironment(),
  });

  console.log(output);
}

/** Only run when invoked as the CLI, so tests can import parseArgs safely. */
const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
