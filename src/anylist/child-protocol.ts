/**
 * The wire contract between the export adapter and the isolated AnyList child
 * (ADR-023 containment).
 *
 * The vocabulary is closed on purpose. A process boundary is a tempting place to
 * "just pass the error through", and doing so would undo the reason the boundary
 * exists: the native library's errors carry response headers, bodies, and the
 * submitted credentials. Nothing crosses this seam except values named here.
 *
 * `httpStatus` is the single piece of provider-derived data permitted across,
 * because the adapter's messages have always included it and dropping it would
 * change externally observable text. It is a status code and nothing else — the
 * parent never sees a message, a header, a body, or a stack.
 */

/** What the parent asks the child to do. Sent as one JSON line on stdin. */
export interface ChildRequest {
  operation: "save";
  /**
   * The already-mapped AnyList payload. Mapping happens in the parent because it
   * is pure and needs no native code, which keeps the child as small as the
   * thing it exists to isolate.
   */
  payload: unknown;
}

/**
 * Why the child could not complete. Mirrors `AnyListErrorCode` plus the two
 * conditions that are the child's own to report.
 */
export type ChildFailureCode =
  | "login_failed"
  | "create_failed"
  | "verify_unreadable"
  | "verify_missing"
  | "missing_credentials"
  | "bad_request";

export type ChildResponse =
  | { ok: true; identifier: string }
  | { ok: false; code: ChildFailureCode; httpStatus: number | null };

const FAILURE_CODES: ReadonlySet<string> = new Set<ChildFailureCode>([
  "login_failed",
  "create_failed",
  "verify_unreadable",
  "verify_missing",
  "missing_credentials",
  "bad_request",
]);

/**
 * Validates a parsed child response against the closed schema.
 *
 * Strict by construction: anything that is not exactly one of the two permitted
 * shapes is rejected rather than coerced. A child that answered with an
 * unexpected field is a child we do not understand, and guessing what it meant
 * is how provider text ends up somewhere it should not be.
 */
export function parseChildResponse(value: unknown): ChildResponse | null {
  if (typeof value !== "object" || value === null) return null;

  const candidate = value as Record<string, unknown>;

  if (candidate["ok"] === true) {
    const identifier = candidate["identifier"];
    if (typeof identifier !== "string" || identifier.length === 0) return null;
    if (Object.keys(candidate).length !== 2) return null;

    return { ok: true, identifier };
  }

  if (candidate["ok"] === false) {
    const code = candidate["code"];
    const httpStatus = candidate["httpStatus"];
    if (typeof code !== "string" || !FAILURE_CODES.has(code)) return null;
    if (httpStatus !== null && !Number.isInteger(httpStatus)) return null;
    if (Object.keys(candidate).length !== 3) return null;

    return { ok: false, code: code as ChildFailureCode, httpStatus: httpStatus as number | null };
  }

  return null;
}
