import type { FailureKind } from "./errors.js";

/**
 * The model the extraction pipeline uses.
 *
 * `src/recipe/parser.ts` owns the real value and does not export it, and that
 * file belongs to another workstream. Rather than reach into it, the literal is
 * mirrored here and pinned by a test that reads the parser source — so a model
 * change surfaces as a failing assertion instead of as telemetry that quietly
 * reports the wrong model for months.
 */
export const EXTRACTION_MODEL = "claude-sonnet-5";

export type FailureStage =
  | "auth"
  | "routing"
  | "validation"
  | "platform"
  | "extraction"
  | "export"
  | "verification"
  | "deadline"
  | "internal";

export type TelemetryRoute = "/api/imports" | "/api/exports/anylist" | "/api/import";

/**
 * One event per request. Counts and durations only — never captions, recipe
 * bodies, ingredient text, credentials, or provider errors.
 */
export interface ImportTelemetry {
  event: "import.telemetry";
  schemaVersion: 1;
  requestId: string;
  route: TelemetryRoute;
  status: number;

  sourcePlatform: string | null;
  sourceType: string | null;
  captionLength: number | null;

  modelUsed: string | null;
  /**
   * Always `null` for now. `parseRecipe()` does not expose Anthropic usage, and
   * parser contracts are deliberately not being changed to serve telemetry.
   */
  inputTokens: number | null;
  outputTokens: number | null;

  processingTimeMs: number;
  extractionMs: number | null;
  exportMs: number | null;

  confidence: number | null;
  warningCount: number | null;

  savedToAnyList: boolean;
  idempotent: boolean;
  idempotencyState: string | null;

  failed: boolean;
  failureStage: FailureStage | null;
  failureKind: string | null;
  /**
   * Machine-readable diagnostic from the source adapter, one level finer than
   * `failureKind`. A closed vocabulary of our own strings — never page content,
   * headers, cookies, or a provider message — so it is safe to log and never
   * appears in an HTTP response body.
   */
  failureReason: string | null;
}

/** Accumulated across a request's phases, then emitted once. */
export interface TelemetryDraft {
  route: TelemetryRoute;
  startedAt: bigint;
  sourcePlatform: string | null;
  sourceType: string | null;
  captionLength: number | null;
  modelUsed: string | null;
  extractionMs: number | null;
  exportMs: number | null;
  confidence: number | null;
  warningCount: number | null;
  savedToAnyList: boolean;
  idempotent: boolean;
  idempotencyState: string | null;
  failureStage: FailureStage | null;
  failureKind: string | null;
  failureReason: string | null;
}

const TELEMETRY_ROUTES: readonly TelemetryRoute[] = [
  "/api/imports",
  "/api/exports/anylist",
  "/api/import",
];

/** Null for routes that carry no telemetry, such as `/health`. */
export function telemetryRouteFor(route: string): TelemetryRoute | null {
  return TELEMETRY_ROUTES.find((known) => known === route) ?? null;
}

export function newDraft(route: TelemetryRoute): TelemetryDraft {
  return {
    route,
    startedAt: process.hrtime.bigint(),
    sourcePlatform: null,
    sourceType: null,
    captionLength: null,
    modelUsed: null,
    extractionMs: null,
    exportMs: null,
    confidence: null,
    warningCount: null,
    savedToAnyList: false,
    idempotent: false,
    idempotencyState: null,
    failureStage: null,
    failureKind: null,
    failureReason: null,
  };
}

export function toTelemetry(
  draft: TelemetryDraft,
  requestId: string,
  status: number,
): ImportTelemetry {
  return {
    event: "import.telemetry",
    schemaVersion: 1,
    requestId,
    route: draft.route,
    status,
    sourcePlatform: draft.sourcePlatform,
    sourceType: draft.sourceType,
    captionLength: draft.captionLength,
    modelUsed: draft.modelUsed,
    inputTokens: null,
    outputTokens: null,
    processingTimeMs: elapsedMsSince(draft.startedAt),
    extractionMs: draft.extractionMs,
    exportMs: draft.exportMs,
    confidence: draft.confidence,
    warningCount: draft.warningCount,
    savedToAnyList: draft.savedToAnyList,
    idempotent: draft.idempotent,
    idempotencyState: draft.idempotencyState,
    failed: status >= 400,
    failureStage: draft.failureStage,
    failureKind: draft.failureKind,
    failureReason: draft.failureReason,
  };
}

/** Where a failure happened, derived from the failure kind rather than guessed. */
export const STAGE_BY_KIND: Record<FailureKind, FailureStage> = {
  unauthorized: "auth",
  not_found: "routing",
  invalid_body: "validation",
  unsupported_schema_version: "validation",
  invalid_idempotency_key: "validation",
  invalid_recipe: "validation",
  body_too_large: "validation",
  unsupported_content_type: "validation",
  invalid_url: "platform",
  unsupported_platform: "platform",
  extraction_failed: "extraction",
  idempotency_conflict: "export",
  export_in_progress: "export",
  export_outcome_unknown: "export",
  export_failed: "export",
  import_failed: "internal",
};

/** Refines the export stage using what the AnyList adapter actually reported. */
export function stageForExportCode(code: string): FailureStage {
  if (code === "verify_unreadable" || code === "verify_missing") return "verification";
  if (code === "export_timeout") return "deadline";

  return "export";
}

export function elapsedMsSince(startedAt: bigint): number {
  return Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
}
