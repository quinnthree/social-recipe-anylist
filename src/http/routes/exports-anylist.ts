import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { resolveDestinationBinding } from "../../anylist/destination.js";
import { ExportError } from "../../app/export-service.js";
import { storeKey, type ClaimResult, type StoredResult } from "../../idempotency/store.js";
import type { RouteContext } from "../context.js";
import { failWith, type FailureKind } from "../errors.js";
import { fingerprintOf } from "../fingerprint.js";
import { RecipeInputSchema } from "../recipe-input.js";
import { checkSchemaVersion, readIdempotencyKey, SUPPORTED_SCHEMA_VERSION } from "../requests.js";
import {
  elapsedMsSince,
  newDraft,
  stageForExportCode,
  STAGE_BY_KIND,
  type TelemetryDraft,
} from "../telemetry.js";

/** A full canonical Recipe does not fit reliably in the 8 KB the URL routes use. */
export const EXPORT_BODY_LIMIT_BYTES = 64 * 1024;

const ROUTE = "exports-anylist";

/**
 * The envelope is validated separately from the recipe so each failure gets its
 * own answer: a malformed envelope is `400 Invalid request body`, a recipe that
 * fails canonical validation is `400 Invalid recipe`. Collapsing them would
 * leave a client unable to tell which half it got wrong.
 */
const EnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(SUPPORTED_SCHEMA_VERSION),
  recipe: z.unknown(),
});

/**
 * `POST /api/exports/anylist` — accepts a canonical Recipe, which the user may
 * have edited, and writes it to AnyList.
 *
 * The export path validates the submitted recipe independently and **never**
 * treats a carried extraction warning as a reason to reject (ADR-010). It also
 * never recomputes `confidence` or `warnings`: those describe what extraction
 * originally produced, and rewriting them after a human correction would
 * destroy the signal they exist to carry.
 */
export function registerExportRoute(server: FastifyInstance, context: RouteContext): void {
  server.post(
    "/api/exports/anylist",
    { bodyLimit: EXPORT_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const draft = request.telemetry ?? newDraft("/api/exports/anylist");
      request.telemetry = draft;
      const requestId = request.id;

      const reject = (failure: FailureKind, kind: string = failure): Promise<void> =>
        rejectWith(request, reply, draft, failure, kind, requestId);

      const version = checkSchemaVersion(request.body);
      if (!version.ok) return reject(version.kind);

      const envelope = EnvelopeSchema.safeParse(request.body);
      if (!envelope.success) return reject("invalid_body");

      // Required here, unlike on /api/imports: this route performs an external
      // write that cannot be undone, so the client must name the attempt.
      const idempotencyKey = readIdempotencyKey(request.headers["idempotency-key"]);
      if (idempotencyKey === null) return reject("invalid_idempotency_key");

      const parsed = RecipeInputSchema.safeParse(envelope.data.recipe);
      if (!parsed.success) return reject("invalid_recipe");

      const recipe = parsed.data;
      draft.sourcePlatform = recipe.source.platform;
      draft.confidence = recipe.confidence;
      draft.warningCount = recipe.warnings.length;

      // Fingerprint the *accepted, normalised* request, never the raw bytes
      // (ADR-018): re-serialising an identical recipe with different key order
      // must not read as a different request.
      const fingerprint = fingerprintOf({
        schemaVersion: SUPPORTED_SCHEMA_VERSION,
        recipe,
      });

      const key = storeKey(ROUTE, idempotencyKey);
      const now = context.now();

      const claim = await context.idempotencyStore.claim({
        key,
        fingerprint,
        requestId,
        // Server-derived, never from the body and never from a header: a client
        // able to name its own destination could aim a replay at an account
        // that is not its own.
        destinationBinding: resolveDestinationBinding(),
        now,
        leaseMs: context.leaseMs,
      });

      if (claim.status !== "claimed") {
        return settleClaimedElsewhere(request, reply, draft, claim, requestId);
      }

      const startedAt = process.hrtime.bigint();

      try {
        const saved = await context.exportRecipe(recipe);
        const result: StoredResult = { id: saved.identifier, name: saved.name };

        // Recording the outcome can fail after the write has already been made
        // and verified. Reporting that as an export failure would be a lie: the
        // recipe is in the account. The record stays `IN_PROGRESS` and its lease
        // later converts it to `AMBIGUOUS`, so a retry is refused rather than
        // duplicated — the stale record fails safe on its own.
        try {
          await context.idempotencyStore.complete(key, requestId, result, context.now());
        } catch {
          request.log.error(
            { event: "idempotency.record_failed", anylistRecipeId: result.id },
            "export succeeded but its idempotency record could not be written",
          );
        }

        draft.exportMs = elapsedMsSince(startedAt);
        draft.savedToAnyList = true;
        draft.idempotencyState = "COMPLETED";

        request.log.info(
          {
            event: "export.completed",
            idempotencyState: "COMPLETED",
            anylistRecipeId: result.id,
            verified: true,
            exportMs: draft.exportMs,
          },
          "recipe exported",
        );

        return {
          success: true,
          schemaVersion: SUPPORTED_SCHEMA_VERSION,
          requestId,
          saved: result,
          idempotent: false,
        };
      } catch (error) {
        draft.exportMs = elapsedMsSince(startedAt);

        // Classified on the code, never on message text.
        const failure =
          error instanceof ExportError
            ? error
            : new ExportError("Export failed.", "AMBIGUOUS", "export_unexpected");

        try {
          await context.idempotencyStore.fail(
            key,
            requestId,
            failure.outcome,
            failure.code,
            context.now(),
          );
        } catch {
          // Same reasoning in reverse: an unrecorded failure leaves the record
          // `IN_PROGRESS`, which its lease converts to `AMBIGUOUS`. Never worse
          // than the truth.
          request.log.error(
            { event: "idempotency.record_failed", failureKind: failure.code },
            "export failed and its idempotency record could not be written",
          );
        }

        draft.idempotencyState = failure.outcome;
        draft.failureKind = failure.code;
        draft.failureStage = stageForExportCode(failure.code);

        request.log.warn(
          {
            event: "export.failed",
            idempotencyState: failure.outcome,
            verified: false,
            failureKind: failure.code,
            failureStage: draft.failureStage,
            exportMs: draft.exportMs,
          },
          "recipe export failed",
        );

        await failWith(reply, "export_failed", requestId);
        return;
      }
    },
  );
}

/**
 * The key was already known. Every branch here returns without calling
 * `createRecipe`, which is the entire point of the mechanism.
 */
async function settleClaimedElsewhere(
  request: FastifyRequest,
  reply: FastifyReply,
  draft: TelemetryDraft,
  claim: Exclude<ClaimResult, { status: "claimed" }>,
  requestId: string,
): Promise<void> {
  if (claim.status === "completed") {
    draft.idempotent = true;
    draft.savedToAnyList = true;
    draft.idempotencyState = "COMPLETED";

    request.log.info(
      {
        event: "export.replayed",
        idempotencyState: "COMPLETED",
        anylistRecipeId: claim.result.id,
        originalRequestId: claim.originalRequestId,
      },
      "recipe export replayed",
    );

    await reply.code(200).send({
      success: true,
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      requestId,
      // The request being answered now, and the request that did the write.
      // Without both, a replay is indistinguishable from a fresh success in
      // logs, which makes duplicate investigation guesswork.
      originalRequestId: claim.originalRequestId,
      saved: claim.result,
      idempotent: true,
    });
    return;
  }

  const failure: FailureKind =
    claim.status === "conflict"
      ? "idempotency_conflict"
      : claim.status === "in_progress"
        ? "export_in_progress"
        : "export_outcome_unknown";

  draft.idempotencyState =
    claim.status === "conflict" ? null : claim.status === "in_progress" ? "IN_PROGRESS" : "AMBIGUOUS";

  await rejectWith(request, reply, draft, failure, claim.status, requestId);
}

async function rejectWith(
  request: FastifyRequest,
  reply: FastifyReply,
  draft: TelemetryDraft,
  failure: FailureKind,
  kind: string,
  requestId: string,
): Promise<void> {
  draft.failureKind = kind;
  draft.failureStage = STAGE_BY_KIND[failure];

  request.log.warn(
    {
      event: "export.rejected",
      failureKind: kind,
      failureStage: draft.failureStage,
      idempotencyState: draft.idempotencyState,
    },
    "recipe export rejected",
  );

  await failWith(reply, failure, requestId);
}
