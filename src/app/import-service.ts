import type { AnyListErrorCode, RecipeSaver } from "../anylist/types.js";
import { parseRecipe } from "../recipe/parser.js";
import type { Recipe } from "../recipe/schema.js";
import { fetchSourceContent } from "../social/index.js";
import {
  ExtractionError,
  type ExtractionFailureReason,
  type SourceContent,
} from "../social/types.js";
import { withTimeout } from "./deadline.js";
import { defaultExportDeps, ExportError, exportRecipe } from "./export-service.js";
import { isUsableRecipe } from "./minimum-recipe.js";

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
    /**
     * Optional machine-readable diagnostic carried up from the source adapter.
     * Safe to log — a closed vocabulary of our own strings, never page content,
     * headers, or a provider message. It never reaches the HTTP response body.
     */
    readonly reason?: ExtractionFailureReason,
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

export interface ExtractOptions {
  deps?: ImportDeps;
  /** Bounds source fetch plus extraction. */
  timeoutMs?: number;
  /**
   * Reports what was fetched, for telemetry.
   *
   * A callback rather than a wider return type, because `SourceContent` is an
   * ingestion detail that no caller of `extractRecipe` should have to receive
   * or thread onward just so one of them can count characters.
   */
  onSourceContent?: (content: SourceContent) => void;
}

export interface ImportOptions extends ExtractOptions {
  dryRun?: boolean;
  /** Bounds the AnyList save-and-verify. */
  exportTimeoutMs?: number;
}

const defaultDeps: ImportDeps = {
  fetchSourceContent,
  parseRecipe,
  createSaver: defaultExportDeps.createSaver,
};

/** Leaves room to answer inside the platform's 120 s function ceiling. */
export const DEFAULT_EXTRACTION_TIMEOUT_MS = 95_000;

const ANYLIST_CODES: ReadonlySet<string> = new Set<AnyListErrorCode>([
  "login_failed",
  "create_failed",
  "verify_unreadable",
  "verify_missing",
]);

const NOT_USABLE =
  "The extracted recipe is not usable: it needs a title, at least one ingredient, and at least one instruction.";

/**
 * URL → validated canonical Recipe. Writes nothing.
 *
 * `POST /api/imports` and the extraction half of every other caller go through
 * here, which is why the acceptance gate lives at this boundary rather than in
 * a route handler (ADR-019, QA-003). Putting it in `/api/imports` alone would
 * leave the legacy `POST /api/import` writing obviously empty recipes into
 * AnyList purely because it predates the newer route — the weaker standard
 * applied to the path that actually writes.
 */
export async function extractRecipe(
  url: string,
  {
    deps = defaultDeps,
    timeoutMs = DEFAULT_EXTRACTION_TIMEOUT_MS,
    onSourceContent,
  }: ExtractOptions = {},
): Promise<Recipe> {
  const recipe = await extract(url, deps, timeoutMs, onSourceContent);

  // Deterministic and structural — never a confidence threshold (ADR-019).
  if (!isUsableRecipe(recipe)) throw new ImportError(NOT_USABLE, "extraction_failed");

  return recipe;
}

/**
 * The single import pipeline. Both `npm run import` and POST /api/import call
 * this; neither reimplements any of it.
 *
 * A dry run stops after validation and never constructs the AnyList adapter, so
 * AnyList is not imported, authenticated, or contacted.
 */
export async function importRecipe(
  url: string,
  { dryRun = false, exportTimeoutMs, ...extractOptions }: ImportOptions = {},
): Promise<ImportResult> {
  const deps = extractOptions.deps ?? defaultDeps;
  const recipe = await extractRecipe(url, extractOptions);

  if (dryRun) return { recipe, saved: null };

  return { recipe, saved: await save(recipe, deps, exportTimeoutMs) };
}

async function extract(
  url: string,
  deps: ImportDeps,
  timeoutMs: number,
  onSourceContent: ((content: SourceContent) => void) | undefined,
): Promise<Recipe> {
  try {
    // Bounded as one unit: neither step has a side effect, so abandoning the
    // wait is safe, and the pair is what the caller actually budgets for.
    return await withTimeout(
      (async () => {
        const content = await deps.fetchSourceContent(url);
        onSourceContent?.(content);
        return deps.parseRecipe(content);
      })(),
      timeoutMs,
      "recipe extraction",
    );
  } catch (error) {
    throw new ImportError(messageOf(error), classifyExtraction(error), reasonOf(error));
  }
}

async function save(
  recipe: Recipe,
  deps: ImportDeps,
  timeoutMs: number | undefined,
): Promise<ImportResult["saved"]> {
  try {
    return await exportRecipe(recipe, {
      deps: { createSaver: deps.createSaver },
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  } catch (error) {
    // ExportError is already redacted at the adapter boundary. `save_failed`
    // means AnyList itself reported the failure; anything else is ours.
    if (error instanceof ExportError) {
      throw new ImportError(error.message, ANYLIST_CODES.has(error.code) ? "save_failed" : "internal");
    }

    throw new ImportError(messageOf(error), "internal");
  }
}

/** Classifies on the social layer's code, never on message text. */
/** Propagates an adapter's diagnostic without inventing one. */
function reasonOf(error: unknown): ExtractionFailureReason | undefined {
  if (error instanceof ImportError) return error.reason;
  if (error instanceof ExtractionError) return error.reason;
  return undefined;
}

function classifyExtraction(error: unknown): ImportFailureKind {
  // The gate already decided; do not reclassify it as an unknown failure.
  if (error instanceof ImportError) return error.kind;

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
