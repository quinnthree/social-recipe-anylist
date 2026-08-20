import { config } from "dotenv";

import { parseRecipe } from "./recipe/parser.js";
import { fetchSourceContent } from "./social/index.js";

// quiet: keep stdout to the recipe JSON alone.
config({ quiet: true });

const USAGE = 'Usage: npm run import -- "<instagram-or-tiktok-url>"';

async function main(): Promise<void> {
  const url = process.argv[2];

  if (url === undefined || url.trim().length === 0) {
    throw new Error(`No URL provided.\n${USAGE}`);
  }

  const content = await fetchSourceContent(url.trim());
  const recipe = await parseRecipe(content);

  console.log(JSON.stringify(recipe, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
