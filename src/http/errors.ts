import type { FastifyReply } from "fastify";

/**
 * Every failure this API can return, as a closed set.
 *
 * `error` is a fixed string chosen by us and selected by failure *kind*. No
 * underlying message, stack, provider error, credential, token, or request
 * internal is ever echoed, and classification never inspects message text.
 */
export type FailureKind =
  | "unauthorized"
  | "invalid_body"
  | "unsupported_schema_version"
  | "invalid_idempotency_key"
  | "invalid_url"
  | "unsupported_platform"
  | "invalid_recipe"
  | "idempotency_conflict"
  | "export_in_progress"
  | "export_outcome_unknown"
  | "body_too_large"
  | "unsupported_content_type"
  | "extraction_failed"
  | "import_failed"
  | "export_failed"
  | "not_found";

export const FAILURES: Record<FailureKind, { status: number; error: string }> = {
  unauthorized: { status: 401, error: "Unauthorized" },
  invalid_body: { status: 400, error: "Invalid request body" },
  unsupported_schema_version: { status: 400, error: "Unsupported schema version" },
  invalid_idempotency_key: { status: 400, error: "Invalid idempotency key" },
  invalid_url: { status: 400, error: "Invalid recipe URL" },
  unsupported_platform: { status: 400, error: "Unsupported platform" },
  invalid_recipe: { status: 400, error: "Invalid recipe" },
  idempotency_conflict: { status: 409, error: "Idempotency key conflict" },
  export_in_progress: { status: 409, error: "Export already in progress" },
  export_outcome_unknown: { status: 409, error: "Export outcome unknown" },
  body_too_large: { status: 413, error: "Request body too large" },
  unsupported_content_type: { status: 415, error: "Unsupported content type" },
  extraction_failed: { status: 422, error: "Recipe could not be extracted" },
  import_failed: { status: 500, error: "Recipe import failed" },
  export_failed: { status: 500, error: "Recipe export failed" },
  not_found: { status: 404, error: "Not found" },
};

/**
 * Maps a Fastify content-type-parser error to our envelope by its **code**, not
 * its message.
 *
 * Before this existed, an oversized body returned `500 Recipe import failed`
 * and a wrong content type returned 400 — both wrong, and both invisible to a
 * client trying to work out what it had done.
 */
export function kindForFastifyCode(code: unknown, statusCode: number): FailureKind {
  if (code === "FST_ERR_CTP_BODY_TOO_LARGE" || statusCode === 413) return "body_too_large";
  if (code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" || statusCode === 415) return "unsupported_content_type";
  if (code === "FST_ERR_CTP_EMPTY_JSON_BODY" || statusCode === 400) return "invalid_body";

  return "import_failed";
}

/** The production error envelope. `requestId` is always present. */
export async function failWith(
  reply: FastifyReply,
  kind: FailureKind,
  requestId: string,
): Promise<void> {
  const { status, error } = FAILURES[kind];
  await reply.code(status).send({ success: false, error, requestId });
}

/**
 * The legacy `POST /api/import` envelope, frozen in Part 1 of the contract: no
 * `requestId` in the body. The header is still sent, which is additive and
 * cannot break a client that does not read it.
 */
export async function failLegacy(
  reply: FastifyReply,
  status: number,
  error: string,
): Promise<void> {
  await reply.code(status).send({ success: false, error });
}
