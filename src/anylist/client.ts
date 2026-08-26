import type { Recipe } from "../recipe/schema.js";
import type { ChildFailureCode } from "./child-protocol.js";
import { createChildRunner, type ChildRunner, type RunnerFailure } from "./child-runner.js";
import { toAnyListRecipe } from "./mapping.js";
import { AnyListError, type RecipeSaver, type SaveResult } from "./types.js";

const LOGIN_FAILED = "AnyList login failed. Check ANYLIST_EMAIL and ANYLIST_PASSWORD in .env.";
const SAVE_FAILED = "Failed to save the recipe to AnyList.";
const MISSING_CREDENTIALS =
  "Missing AnyList credentials. Set ANYLIST_EMAIL and ANYLIST_PASSWORD in .env (see .env.example).";
const VERIFY_UNREADABLE =
  "AnyList accepted the save request, but the recipe could not be read back to verify it.";
const VERIFY_MISSING =
  "AnyList accepted the save request, but the recipe could not be verified in the account.";

/**
 * The isolated worker could not be started. Nothing was attempted, which is why
 * this is classified alongside a login failure rather than an ambiguous one.
 */
const WORKER_UNAVAILABLE = "The AnyList worker process could not be started.";

/**
 * The isolated worker died, timed out, or answered in a shape we do not
 * understand. It may already have written the recipe, so this is never treated
 * as safe to retry.
 */
const WORKER_OUTCOME_UNKNOWN =
  "The AnyList worker process did not report a usable outcome, so the save may or may not have completed.";

/**
 * Writes a canonical Recipe to AnyList through an isolated child process
 * (ADR-023).
 *
 * This file — and every other file in production source — is forbidden from
 * loading `@anylist-napi/anylist-napi`; only `./child/anylist-child.mjs` may,
 * and `tests/architecture/anylist-import-boundary.test.ts` fails CI otherwise.
 * The native library writes response metadata including `set-cookie` to file
 * descriptor 2 from Rust, below any JavaScript interception, so the descriptor
 * has to belong to a pipe we own rather than to the platform log.
 *
 * The externally observable contract is unchanged: the same `AnyListError`
 * codes, the same message text, the same `(HTTP nnn)` suffix where a status was
 * reachable, and the same `SaveResult`. What moved is where the native call
 * happens, not what a caller sees.
 */
export class AnyListRecipeSaver implements RecipeSaver {
  constructor(private readonly run: ChildRunner) {}

  /**
   * Builds a saver from ANYLIST_EMAIL / ANYLIST_PASSWORD.
   *
   * Credentials are validated here and then **not carried anywhere**: the child
   * reads them from the inherited environment, so they appear in neither argv
   * nor the request protocol. Authentication architecture is unchanged by this
   * milestone.
   */
  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): AnyListRecipeSaver {
    const email = env["ANYLIST_EMAIL"]?.trim();
    const password = env["ANYLIST_PASSWORD"];

    // Missing configuration is a login failure by the only classification that
    // matters downstream: no request was made, so no recipe can exist.
    if (!email || !password) throw new AnyListError(MISSING_CREDENTIALS, "login_failed");

    return new AnyListRecipeSaver(createChildRunner());
  }

  async save(recipe: Recipe): Promise<SaveResult> {
    // Mapping is pure and needs no native code, so it stays in this process.
    // Keeping it here is also what preserves `SaveResult.name`: it has always
    // been the mapped payload's name, not anything AnyList echoed back.
    const payload = toAnyListRecipe(recipe);

    const outcome = await this.run({ operation: "save", payload });

    if (!outcome.ok) throw runnerFailure(outcome.failure);

    const response = outcome.response;
    if (response.ok) return { name: payload.name, identifier: response.identifier };

    throw childFailure(response.code, response.httpStatus);
  }
}

/**
 * Translates the child's closed vocabulary into the adapter's, preserving both
 * the code and the exact message text callers have always seen.
 */
function childFailure(code: ChildFailureCode, httpStatus: number | null): AnyListError {
  switch (code) {
    case "missing_credentials":
      return new AnyListError(MISSING_CREDENTIALS, "login_failed");
    case "login_failed":
      return new AnyListError(withStatus(LOGIN_FAILED, httpStatus), "login_failed");
    case "create_failed":
      return new AnyListError(withStatus(SAVE_FAILED, httpStatus), "create_failed");
    case "verify_unreadable":
      return new AnyListError(withStatus(VERIFY_UNREADABLE, httpStatus), "verify_unreadable");
    case "verify_missing":
      // Deliberately carries no status: the read succeeded, so there is no
      // failing HTTP response to name. Unchanged from before containment.
      return new AnyListError(VERIFY_MISSING, "verify_missing");
    case "bad_request":
      // The child rejected our request shape, which it does before touching the
      // network. A parent/child mismatch is a bug, but it is a safe one.
      return new AnyListError(WORKER_UNAVAILABLE, "login_failed");
  }
}

/**
 * Translates a transport-level failure of the worker itself.
 *
 * The split is the same one the rest of the export path turns on: only positive
 * evidence that no write was attempted may be reported as safe. A child that
 * never started is safe. A child that died, timed out, or spoke nonsense may
 * have reached `createRecipe` first, and a duplicate cannot be removed
 * afterwards — `deleteRecipe()` returns success without deleting (ADR-021).
 */
function runnerFailure(failure: RunnerFailure): AnyListError {
  if (failure === "spawn_failed") return new AnyListError(WORKER_UNAVAILABLE, "login_failed");

  return new AnyListError(WORKER_OUTCOME_UNKNOWN, "create_failed");
}

/**
 * Appends an HTTP status when the child was able to read one. The status code is
 * the only provider-derived value permitted across the process boundary; no
 * message, header, body, or stack crosses it.
 */
function withStatus(message: string, status: number | null): string {
  return status === null ? message : `${message} (HTTP ${status})`;
}
