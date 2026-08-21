import { AnyListClient } from "@anylist-napi/anylist-napi";

import { OutputGuard } from "./lib/redact.js";
import { describeError, guardTokens, probeName, readTokens } from "./lib/session.js";

/**
 * Experiment 7 — does `createRecipe()` really persist prepTime/cookTime as 0?
 *
 * The project documents this as an upstream bug and works around it by writing
 * every stated time into the recipe note. Experiment 5 showed the times survive
 * an `updateRecipe()` round trip intact, so the claim needs testing on the
 * create path specifically — that is the path production actually uses.
 *
 * This creates a permanent recipe: `deleteRecipe()` does not work (experiment
 * 4), so the probe must be removed by hand in the AnyList app afterwards. Run
 * deliberately, not as part of a sweep.
 */
async function main(): Promise<void> {
  const guard = new OutputGuard();
  const tokens = readTokens();
  guardTokens(guard, tokens);

  const client = AnyListClient.fromTokens(tokens);

  const created = await client.createRecipe({
    name: probeName("create-times"),
    ingredients: [{ name: "Water", quantity: "1 cup" }],
    preparationSteps: ["Automated research probe. Delete this recipe by hand."],
    note: "Probe for the prepTime/cookTime zero-persistence claim.",
    servings: "4",
    prepTime: 15,
    cookTime: 40,
  });

  guard.log("createRecipe() returned (client-side echo, not a server read):", {
    recipeId: created.id,
    prepTime: created.prepTime,
    cookTime: created.cookTime,
    servings: created.servings,
  });

  try {
    const stored = await client.getRecipeById(created.id);
    guard.log("read back from AnyList:", {
      recipeId: created.id,
      prepTime: stored.prepTime,
      cookTime: stored.cookTime,
      servings: stored.servings,
      note: stored.note === "Probe for the prepTime/cookTime zero-persistence claim.",
      zeroPersistenceReproduced: stored.prepTime === 0 || stored.cookTime === 0,
    });
  } catch (error) {
    guard.log("read back FAILED:", describeError(guard, error));
    process.exitCode = 1;
  }

  guard.log("DELETE THIS RECIPE BY HAND IN ANYLIST:", { recipeId: created.id });
}

main().catch((error: unknown) => {
  const guard = new OutputGuard();
  console.error("experiment failed:", describeError(guard, error));
  process.exitCode = 1;
});
