import type { Ingredient, Recipe, TimeRange } from "../recipe/schema.js";
import type { CreateRecipeOptions, IngredientInput } from "./types.js";

const EN_DASH = "–";

/**
 * Maps a validated Recipe onto the AnyList payload. Pure: no I/O and no runtime
 * dependency on the AnyList library, so it is fully testable without live calls.
 *
 * Optional keys are omitted rather than set to undefined, because the library's
 * types declare them as `?: string` and the project runs with
 * exactOptionalPropertyTypes.
 */
export function toAnyListRecipe(recipe: Recipe): CreateRecipeOptions {
  const options: CreateRecipeOptions = {
    name: recipe.title,
    ingredients: recipe.ingredients.map(toAnyListIngredient),
    preparationSteps: recipe.instructions,
    sourceUrl: recipe.source.url,
  };

  const note = buildNote(recipe);
  if (note !== undefined) options.note = note;

  if (recipe.source.creator !== null) options.sourceName = recipe.source.creator;

  // Losslessly textual: AnyList's servings field is a string. No invented units.
  if (recipe.servings !== null) options.servings = `${recipe.servings}`;

  // Minutes, not seconds. The library has a known bug where these persist as 0;
  // they are sent anyway so a future fix upstream benefits us automatically,
  // and buildNote preserves the stated time regardless.
  if (recipe.prepTime !== null) options.prepTime = recipe.prepTime.minMinutes;
  if (recipe.cookTime !== null) options.cookTime = recipe.cookTime.minMinutes;

  return options;
}

/**
 * The recipe note carries every explicitly stated time, not just ranges, because
 * the numeric prepTime/cookTime fields currently persist as 0 upstream.
 */
export function buildNote(recipe: Recipe): string | undefined {
  const lines: string[] = [];

  if (recipe.description !== null) lines.push(recipe.description);

  const prep = describeTime(recipe.prepTime);
  if (prep !== null) lines.push(`Prep time stated in source: ${prep}`);

  const cook = describeTime(recipe.cookTime);
  if (cook !== null) lines.push(`Cook time stated in source: ${cook}`);

  return lines.length > 0 ? lines.join("\n") : undefined;
}

/** "40 minutes" for an exact time, "35–40 minutes" for a range. Ranges are never averaged. */
function describeTime(time: TimeRange | null): string | null {
  if (time === null) return null;

  return time.maxMinutes === null
    ? `${time.minMinutes} minutes`
    : `${time.minMinutes}${EN_DASH}${time.maxMinutes} minutes`;
}

/**
 * AnyList ingredients carry name, quantity, and note only. `rawText` stays in
 * our normalised Recipe and is deliberately not transmitted.
 */
export function toAnyListIngredient(ingredient: Ingredient): IngredientInput {
  const mapped: IngredientInput = { name: ingredient.name };

  const quantity = formatQuantity(ingredient);
  if (quantity !== undefined) mapped.quantity = quantity;

  if (ingredient.preparation !== null) mapped.note = ingredient.preparation;

  return mapped;
}

/** AnyList shows quantity and unit as one string. */
function formatQuantity(ingredient: Ingredient): string | undefined {
  const combined = [ingredient.quantity, ingredient.unit]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(" ");

  return combined.length > 0 ? combined : undefined;
}
