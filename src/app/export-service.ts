import { AnyListRecipeSaver } from "../anylist/client.js";
import { AnyListError, type AnyListErrorCode, type RecipeSaver, type SaveResult } from "../anylist/types.js";
import type { Recipe } from "../recipe/schema.js";
import { TimeoutError, withTimeout } from "./deadline.js";

/**
 * What a failed export implies about the AnyList account.
 *
 * This is the application's judgement, not the adapter's. `src/anylist/`
 * reports **what happened**; deciding whether that leaves a recipe behind needs
 * idempotency context the adapter does not have (ADR-020).
 */
export type ExportOutcome = "FAILED_SAFE" | "AMBIGUOUS";

export class ExportError extends Error {
  constructor(
    message: string,
    readonly outcome: ExportOutcome,
    /** A stable discriminator for logs and telemetry. Never shown to a client. */
    readonly code: string,
  ) {
    super(message);
    this.name = "ExportError";
  }
}

/**
 * Only `login_failed` carries positive evidence that no write was attempted.
 *
 * The other three are non-retryable on purpose. A `createRecipe` exception
 * proves nothing — the request may have been received and applied before the
 * connection died — and a duplicate cannot be cleaned up afterwards, because
 * `deleteRecipe()` returns success without deleting (ADR-021). The conservative
 * direction is the only affordable one.
 */
const OUTCOME_BY_CODE: Record<AnyListErrorCode, ExportOutcome> = {
  login_failed: "FAILED_SAFE",
  create_failed: "AMBIGUOUS",
  verify_unreadable: "AMBIGUOUS",
  verify_missing: "AMBIGUOUS",
};

export interface ExportDeps {
  createSaver: () => RecipeSaver;
}

export const defaultExportDeps: ExportDeps = {
  createSaver: () => AnyListRecipeSaver.fromEnvironment(),
};

export interface ExportOptions {
  deps?: ExportDeps;
  /** Wall-clock bound on the whole save-and-verify. */
  timeoutMs?: number;
}

/** Comfortably inside the 120 s function ceiling, with room to answer after it. */
export const DEFAULT_EXPORT_TIMEOUT_MS = 90_000;

/**
 * Writes a canonical Recipe to AnyList and confirms it persisted.
 *
 * The whole `save()` is bounded as one unit rather than per step, because
 * `RecipeSaver` exposes login, create, and verify as a single operation. That
 * costs precision — a timeout cannot tell us which step was in flight — and the
 * safe reading of "we do not know" is `AMBIGUOUS`.
 */
export async function exportRecipe(
  recipe: Recipe,
  { deps = defaultExportDeps, timeoutMs = DEFAULT_EXPORT_TIMEOUT_MS }: ExportOptions = {},
): Promise<SaveResult> {
  const saver = buildSaver(deps);

  try {
    return await withTimeout(saver.save(recipe), timeoutMs, "AnyList export");
  } catch (error) {
    throw classifySaveFailure(error);
  }
}

/**
 * Constructing the saver provably precedes any AnyList call, so a failure here
 * is safe by position rather than by inference — including the missing-
 * credentials case, which the adapter already reports as `login_failed`.
 */
function buildSaver(deps: ExportDeps): RecipeSaver {
  try {
    return deps.createSaver();
  } catch (error) {
    if (error instanceof AnyListError) {
      throw new ExportError(error.message, OUTCOME_BY_CODE[error.code], error.code);
    }

    throw new ExportError(messageOf(error), "FAILED_SAFE", "saver_unavailable");
  }
}

function classifySaveFailure(error: unknown): ExportError {
  if (error instanceof ExportError) return error;

  // Classified on the code, never on the message: message text is human-facing
  // and may be reworded, and a provider error can carry submitted credentials.
  if (error instanceof AnyListError) {
    return new ExportError(error.message, OUTCOME_BY_CODE[error.code], error.code);
  }

  if (error instanceof TimeoutError) {
    // We stopped waiting. The native client has no cancellation, so the write
    // may still be in flight. This is the definition of ambiguous.
    return new ExportError(error.message, "AMBIGUOUS", "export_timeout");
  }

  // An unrecognised throw from inside save(). We cannot prove createRecipe was
  // not reached, so we do not get to assume it wasn't.
  return new ExportError(messageOf(error), "AMBIGUOUS", "export_unexpected");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
