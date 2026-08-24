import type { Ingredient, Recipe } from "../recipe/schema.js";

/**
 * The acceptance gate: can a person actually cook from this (ADR-019).
 *
 * Deterministic and structural, and explicitly **not** a confidence threshold.
 * QA's golden corpus established that `confidence` does not correlate reliably
 * enough with whether edits are required to gate acceptance on it — gating on a
 * score that does not predict the thing it is gating would reject usable
 * recipes and admit unusable ones, with no way for a user to tell which had
 * happened.
 *
 * `confidence` and `warnings` stay an extraction-time assessment (ADR-010) and
 * take no part in this decision. A recipe carrying warnings is a normal,
 * successful, exportable recipe.
 *
 * Entries are counted by meaning, not by presence (QA-025). The canonical
 * schema's `min(1)` admits `"   "`, so an array can be non-empty while holding
 * nothing a person could read. One meaningful entry is enough — a list that is
 * mostly blank but contains a real ingredient is still a recipe, and dropping
 * it would reject usable extractions.
 *
 * This inspects; it never rewrites. No trimmed value is written back, no field
 * is normalised, and the recipe that passes the gate is byte-for-byte the
 * recipe that entered it.
 */
export function isUsableRecipe(recipe: Recipe): boolean {
  return (
    recipe.title.trim().length > 0 &&
    recipe.ingredients.some(isMeaningfulIngredient) &&
    recipe.instructions.some(isMeaningfulInstruction)
  );
}

/**
 * An ingredient is meaningful when it names something. `quantity`, `unit`,
 * `preparation`, and `rawText` are left entirely alone: a nameless entry is
 * unusable however well-quantified, and a bare name is usable without any of
 * them.
 */
function isMeaningfulIngredient(ingredient: Ingredient): boolean {
  return ingredient.name.trim().length > 0;
}

function isMeaningfulInstruction(instruction: string): boolean {
  return instruction.trim().length > 0;
}
