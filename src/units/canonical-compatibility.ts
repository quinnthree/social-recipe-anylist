import type { Ingredient } from "../recipe/schema.js";
import type { MeasuredInput } from "./project.js";

/**
 * Compile-time proof that a canonical `Ingredient` can be projected.
 *
 * The engine reads a structural `MeasuredInput` rather than importing the
 * canonical type directly, so that no module under `src/units/` has a runtime
 * dependency on the recipe schema and the engine stays genuinely dormant. That
 * independence is only safe if the two shapes cannot drift apart, which is what
 * this file checks.
 *
 * The import is **type-only** and is erased at compile time: this file loads
 * nothing at runtime and is never executed. If `Ingredient` loses a field the
 * engine reads, or changes one's type, this stops compiling — a build failure
 * naming exactly what diverged, rather than a projection that silently reads
 * `undefined`.
 */
const _canonicalIngredientIsProjectable: (ingredient: Ingredient) => MeasuredInput = (
  ingredient,
) => ingredient;

void _canonicalIngredientIsProjectable;
