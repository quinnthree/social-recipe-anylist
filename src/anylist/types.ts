import type { Recipe } from "../recipe/schema.js";

/** An ingredient in the shape AnyList's PBIngredient message expects. */
export interface AnyListIngredient {
  rawIngredient: string;
  name: string;
  quantity?: string | undefined;
  note?: string | undefined;
}

/** A recipe in the shape AnyList's PBRecipe message expects. */
export interface AnyListRecipe {
  name: string;
  note?: string | undefined;
  sourceName?: string | undefined;
  sourceUrl: string;
  servings?: string | undefined;
  preparationSteps: string[];
  ingredients: AnyListIngredient[];
  /** Seconds. AnyList stores prep and cook time as int32 seconds. */
  prepTime?: number | undefined;
  cookTime?: number | undefined;
}

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
 * underlying third-party error is never attached, serialised, or used as
 * `cause`, because it can reach the submitted credentials through
 * `response.request.options`.
 */
export class AnyListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnyListError";
  }
}
