import type { Recipe } from "../recipe/schema.js";

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
 */
export function isUsableRecipe(recipe: Recipe): boolean {
  return (
    recipe.title.trim().length > 0 &&
    recipe.ingredients.length > 0 &&
    recipe.instructions.length > 0
  );
}
