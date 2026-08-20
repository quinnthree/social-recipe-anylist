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
 * An application-level failure. Messages are fixed strings chosen by us; the
 * underlying library error is never attached, serialised, or used as `cause`,
 * so credentials, tokens, and request details cannot escape through it.
 */
export class AnyListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnyListError";
  }
}
