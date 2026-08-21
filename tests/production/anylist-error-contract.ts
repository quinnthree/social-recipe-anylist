import type { ExportOutcome } from "../../src/app/export-service.js";
import type { ClaimStatus } from "./idempotency-contract.js";

/**
 * The approved AnyList error classification (contracts.md "AnyList error
 * classification", ADR-020).
 *
 * NOT IMPLEMENTED: `AnyListError` carries no `code` today. This module is the
 * contract expressed as data so the mapping can be asserted before the source
 * change lands, and so the Backend agent has an executable target.
 */

export type AnyListErrorCode =
  /** Authentication failed, so createRecipe was never reached. */
  | "login_failed"
  /** createRecipe threw. The call was made; the outcome is not known. */
  | "create_failed"
  /** The post-save read-back itself failed. */
  | "verify_unreadable"
  /** The read-back completed and found nothing. */
  | "verify_missing";

export const ANYLIST_ERROR_CODES: readonly AnyListErrorCode[] = [
  "login_failed",
  "create_failed",
  "verify_unreadable",
  "verify_missing",
];

/**
 * How the application layer interprets each fact the AnyList layer reports.
 *
 * The split matters: the adapter states *what happened*; only the application
 * decides what that implies for retry safety, because retry safety is a
 * property of the external side effect, not of the exception (ADR-020).
 */
export const CODE_TO_STATE: Record<AnyListErrorCode, ExportOutcome> = {
  // The only code carrying positive evidence that no write was attempted.
  login_failed: "FAILED_SAFE",
  // A thrown exception does not prove the write did not land.
  create_failed: "AMBIGUOUS",
  // The write may have succeeded and only the read-back failed.
  verify_unreadable: "AMBIGUOUS",
  // Read-back found nothing, but eventual consistency cannot be ruled out.
  verify_missing: "AMBIGUOUS",
};

/** Which failure in the adapter must produce which code. */
export const SCENARIO_TO_CODE = {
  loginThrows: "login_failed",
  createThrows: "create_failed",
  verifyThrows: "verify_unreadable",
  verifyReturnsNull: "verify_missing",
  verifyReturnsOtherId: "verify_missing",
} as const satisfies Record<string, AnyListErrorCode>;

/**
 * What a recorded outcome means for the *next* claim on the same key.
 *
 * The store collapses `FAILED_SAFE` into `claimed`, because a re-claim is the
 * `FAILED_SAFE → IN_PROGRESS` transition. `AMBIGUOUS` stays itself, and is the
 * one outcome that never becomes claimable again.
 */
export const OUTCOME_TO_CLAIM_STATUS: Record<ExportOutcome, ClaimStatus> = {
  FAILED_SAFE: "claimed",
  AMBIGUOUS: "ambiguous",
};
