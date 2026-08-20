import type { Ingredient, Recipe, TimeRange } from "../recipe/schema.js";
import type { AnyListIngredient, AnyListRecipe } from "./types.js";

const SECONDS_PER_MINUTE = 60;
const EN_DASH = "–";

/**
 * Maps a validated Recipe onto the AnyList payload shape. Pure: no I/O, no
 * dependency on the anylist package, so it is testable without live calls.
 */
export function toAnyListRecipe(recipe: Recipe): AnyListRecipe {
  return {
    name: recipe.title,
    note: buildNote(recipe),
    sourceName: recipe.source.creator ?? undefined,
    sourceUrl: recipe.source.url,
    servings: formatServings(recipe.servings),
    preparationSteps: recipe.instructions,
    ingredients: recipe.ingredients.map(toAnyListIngredient),
    prepTime: toSeconds(recipe.prepTime),
    cookTime: toSeconds(recipe.cookTime),
  };
}

/**
 * AnyList's `servings` is a protobuf string field; encoding a number throws
 * "Illegal value for servings ... (not a string)". The value is passed through
 * verbatim as text — no rounding, no unit invention, no normalisation.
 */
function formatServings(servings: number | null): string | undefined {
  return servings === null ? undefined : `${servings}`;
}

/** Converts a stated duration to seconds using the lower bound. Ranges are never averaged. */
export function toSeconds(time: TimeRange | null): number | undefined {
  return time === null ? undefined : time.minMinutes * SECONDS_PER_MINUTE;
}

/**
 * AnyList holds a single numeric time per field, so a stated range would lose
 * its upper bound. The full range is preserved in the recipe note instead.
 */
export function buildNote(recipe: Recipe): string | undefined {
  const lines: string[] = [];

  if (recipe.description !== null) lines.push(recipe.description);

  const prep = describeRange(recipe.prepTime);
  if (prep !== null) lines.push(`Prep time stated in source: ${prep}`);

  const cook = describeRange(recipe.cookTime);
  if (cook !== null) lines.push(`Cook time stated in source: ${cook}`);

  return lines.length > 0 ? lines.join("\n") : undefined;
}

/** Only a genuine range needs preserving; an exact time survives in the numeric field. */
function describeRange(time: TimeRange | null): string | null {
  if (time === null || time.maxMinutes === null) return null;
  return `${time.minMinutes}${EN_DASH}${time.maxMinutes} minutes`;
}

export function toAnyListIngredient(ingredient: Ingredient): AnyListIngredient {
  return {
    rawIngredient: ingredient.rawText || reconstructRawText(ingredient),
    name: ingredient.name,
    quantity: formatQuantity(ingredient),
    note: ingredient.preparation ?? undefined,
  };
}

/** Fallback for an ingredient that arrived without its original line. */
function reconstructRawText(ingredient: Ingredient): string {
  const measured = [ingredient.quantity, ingredient.unit, ingredient.name]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(" ");

  return ingredient.preparation === null ? measured : `${measured}, ${ingredient.preparation}`;
}

/** AnyList shows quantity and unit as one string. */
function formatQuantity(ingredient: Ingredient): string | undefined {
  const combined = [ingredient.quantity, ingredient.unit]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(" ");

  return combined.length > 0 ? combined : undefined;
}
