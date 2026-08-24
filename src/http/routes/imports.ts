import type { FastifyInstance } from "fastify";

import { ImportError, type ImportFailureKind } from "../../app/import-service.js";
import type { RouteContext } from "../context.js";
import { failWith, type FailureKind } from "../errors.js";
import { isHttpUrl } from "../recipe-input.js";
import { checkSchemaVersion, ImportsRequestSchema, SUPPORTED_SCHEMA_VERSION } from "../requests.js";
import { elapsedMsSince, EXTRACTION_MODEL, newDraft, STAGE_BY_KIND } from "../telemetry.js";

export const IMPORTS_BODY_LIMIT_BYTES = 8 * 1024;

/**
 * Extraction failures reuse the frozen classification rather than inventing a
 * parallel one. `save_failed` cannot occur here — this route constructs no
 * saver — but it is mapped rather than left to fall through, so a future
 * refactor that changed that would produce a redacted 500 and not a crash.
 */
const FAILURE_BY_KIND: Record<ImportFailureKind, FailureKind> = {
  invalid_url: "invalid_url",
  unsupported_platform: "unsupported_platform",
  extraction_failed: "extraction_failed",
  save_failed: "import_failed",
  internal: "import_failed",
};

/**
 * `POST /api/imports` — extraction only. **Writes nothing to AnyList.**
 *
 * Returns the complete canonical Recipe, because the client needs every field
 * to render the review screen. That is the whole reason this route exists
 * separately from the one-shot `POST /api/import`, which commits to AnyList
 * before a person has seen anything (ADR-007).
 *
 * No durable idempotency: the route performs no external write, so a replay
 * costs an extraction and nothing else.
 */
export function registerImportsRoute(server: FastifyInstance, context: RouteContext): void {
  server.post(
    "/api/imports",
    { bodyLimit: IMPORTS_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const draft = request.telemetry ?? newDraft("/api/imports");
      request.telemetry = draft;
      const requestId = request.id;

      const reject = async (
        failure: FailureKind,
        kind: string = failure,
        reason?: string,
      ): Promise<void> => {
        draft.failureKind = kind;
        draft.failureStage = STAGE_BY_KIND[failure];
        if (reason !== undefined) draft.failureReason = reason;

        // The kind and our own reason vocabulary, never the error: a provider
        // error can carry credentials, and page content can carry the caption.
        request.log.warn(
          {
            event: "extraction.failed",
            failureKind: kind,
            failureStage: draft.failureStage,
            failureReason: draft.failureReason,
          },
          "recipe extraction failed",
        );

        await failWith(reply, failure, requestId);
      };

      const version = checkSchemaVersion(request.body);
      if (!version.ok) return reject(version.kind);

      const body = ImportsRequestSchema.safeParse(request.body);
      if (!body.success) return reject("invalid_body");

      // Before any fetch, any model call, any cost. `z.string().url()` admits
      // javascript:, file:, and data: — none of which belong anywhere near the
      // ingestion layer.
      if (!isHttpUrl(body.data.url)) return reject("invalid_url");

      const startedAt = process.hrtime.bigint();

      try {
        const recipe = await context.extractRecipe(body.data.url, {
          onSourceContent: (content) => {
            draft.sourcePlatform = content.platform;
            draft.sourceType = content.textSource;
            draft.captionLength = content.text.length;
          },
        });

        draft.extractionMs = elapsedMsSince(startedAt);
        draft.modelUsed = EXTRACTION_MODEL;
        draft.sourcePlatform = recipe.source.platform;
        draft.confidence = recipe.confidence;
        draft.warningCount = recipe.warnings.length;

        // Title only, never the body: enough to identify the import in a log,
        // nothing that reproduces the caption or the ingredient list.
        request.log.info(
          {
            event: "extraction.completed",
            platform: recipe.source.platform,
            sourceType: draft.sourceType,
            captionLength: draft.captionLength,
            title: recipe.title,
            confidence: recipe.confidence,
            warningCount: recipe.warnings.length,
            extractionMs: draft.extractionMs,
          },
          "recipe extracted",
        );

        return {
          success: true,
          schemaVersion: SUPPORTED_SCHEMA_VERSION,
          requestId,
          recipe,
        };
      } catch (error) {
        draft.extractionMs = elapsedMsSince(startedAt);
        const kind: ImportFailureKind = error instanceof ImportError ? error.kind : "internal";
        const reason = error instanceof ImportError ? error.reason : undefined;

        // A source failure happens before any SourceContent exists, so
        // draft.sourcePlatform is still null. The reason vocabulary is
        // platform-prefixed, which is what makes the failure diagnosable.
        return reject(FAILURE_BY_KIND[kind], kind, reason);
      }
    },
  );
}
