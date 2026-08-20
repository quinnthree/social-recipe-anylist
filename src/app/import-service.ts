import { AnyListRecipeSaver } from "../anylist/client.js";
import { AnyListError, type RecipeSaver } from "../anylist/types.js";
import { parseRecipe } from "../recipe/parser.js";
import type { Recipe } from "../recipe/schema.js";
import { fetchSourceContent } from "../social/index.js";
import { ExtractionError } from "../social/types.js";

/**
 * Why an import failed, as a stable discriminator. Callers map this to their own
 * output — an exit code for the CLI, an HTTP status for the API — and never
 * inspect the message, which may originate from a third party.
 */
export type ImportFailureKind =
  | "invalid_url"
  | "unsupported_platform"
  | "extraction_failed"
  | "save_failed"
  | "internal";

export class ImportError extends Error {
  constructor(
    message: string,
    readonly kind: ImportFailureKind,
  ) {
    super(message);
    this.name = "ImportError";
  }
}

export interface ImportResult {
  recipe: Recipe;
  /** null on a dry run, since nothing was saved. */
  saved: { name: string; identifier: string } | null;
}

/** Injectable for tests. Defaults are the real pipeline. */
export interface ImportDeps {
  fetchSourceContent: typeof fetchSourceContent;
  parseRecipe: typeof parseRecipe;
  createSaver: () => RecipeSaver;
}

export interface ImportOptions {
  dryRun?: boolean;
  deps?: ImportDeps;
}

const defaultDeps: ImportDeps = {
  fetchSourceContent,
  parseRecipe,
  createSaver: () => AnyListRecipeSaver.fromEnvironment(),
};

/**
 * The single import pipeline. Both `npm run import` and POST /api/import call
 * this; neither reimplements any of it.
 *
 * A dry run stops after validation and never constructs the AnyList adapter, so
 * AnyList is not imported, authenticated, or contacted.
 */
export async function importRecipe(
  url: string,
  { dryRun = false, deps = defaultDeps }: ImportOptions = {},
): Promise<ImportResult> {
  const recipe = await extract(url, deps);

  if (dryRun) return { recipe, saved: null };

  return { recipe, saved: await save(recipe, deps) };
}

async function extract(url: string, deps: ImportDeps): Promise<Recipe> {
  try {
    const content = await deps.fetchSourceContent(url);
    return await deps.parseRecipe(content);
  } catch (error) {
    throw new ImportError(messageOf(error), classifyExtraction(error));
  }
}

async function save(recipe: Recipe, deps: ImportDeps): Promise<ImportResult["saved"]> {
  try {
    return await deps.createSaver().save(recipe);
  } catch (error) {
    // AnyListError is already redacted at the adapter boundary.
    throw new ImportError(messageOf(error), error instanceof AnyListError ? "save_failed" : "internal");
  }
}

/** Classifies on the social layer's code, never on message text. */
function classifyExtraction(error: unknown): ImportFailureKind {
  if (!(error instanceof ExtractionError)) {
    // A parser or model failure: the URL was fine, the recipe was not extractable.
    return "extraction_failed";
  }

  switch (error.code) {
    case "invalid_url":
      return "invalid_url";
    case "unsupported_platform":
      return "unsupported_platform";
    case "source_unavailable":
      return "extraction_failed";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
