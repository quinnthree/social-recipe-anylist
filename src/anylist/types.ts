import type { CreateRecipeOptions, IngredientInput } from "@anylist-napi/anylist-napi";

import type { Recipe } from "../recipe/schema.js";

/**
 * The destination payload types come straight from the library, so a change in
 * its shape becomes a compile error here rather than a runtime surprise. These
 * are type-only imports, so nothing is loaded at runtime — a dry run never
 * touches the native module.
 */
export type { CreateRecipeOptions, IngredientInput };

export interface SaveResult {
  name: string;
  identifier: string;
}

/** The seam between recipe extraction and AnyList. Extraction never sees past this. */
export interface RecipeSaver {
  save(recipe: Recipe): Promise<SaveResult>;
}

/**
 * What went wrong, as a stable discriminator callers can branch on without
 * reading `message` — which is human-facing text and may be reworded.
 *
 * These are **facts about the AnyList call**, not retry advice. This layer
 * deliberately does not know what `FAILED_SAFE` or `AMBIGUOUS` mean; deciding
 * whether a failure is safe to retry is the backend's job, and it needs to know
 * exactly which step failed to decide it.
 *
 * The distinction that matters is whether `createRecipe` was reached:
 *
 * - `login_failed` — no write was attempted.
 * - `create_failed` — the write was attempted and its outcome is unknown.
 * - `verify_unreadable` — the write was attempted and the read-back failed.
 * - `verify_missing` — the write was attempted and the recipe was not there.
 */
export type AnyListErrorCode =
  | "login_failed"
  | "create_failed"
  | "verify_unreadable"
  | "verify_missing";

/**
 * An application-level failure. Messages are fixed strings chosen by us; the
 * underlying library error is never attached, serialised, or used as `cause`,
 * so credentials, tokens, and request details cannot escape through it.
 */
export class AnyListError extends Error {
  constructor(
    message: string,
    readonly code: AnyListErrorCode,
  ) {
    super(message);
    this.name = "AnyListError";
  }
}
