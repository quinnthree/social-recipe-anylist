import { AnyListClient } from "@anylist-napi/anylist-napi";

import { OutputGuard } from "./lib/redact.js";
import { PROBE_PREFIX, describeError, guardTokens, readTokens } from "./lib/session.js";

/**
 * Deletes every recipe these experiments created. Probe recipes carry a fixed
 * name prefix, so this can never touch a real recipe.
 *
 * Run it after any experiment that exits unexpectedly, and once at the end.
 */
async function main(): Promise<void> {
  const guard = new OutputGuard();
  const tokens = readTokens();
  guardTokens(guard, tokens);

  const client = AnyListClient.fromTokens(tokens);
  const recipes = await client.getRecipes();
  const probes = recipes.filter((recipe) => recipe.name.startsWith(PROBE_PREFIX));

  guard.log("scan:", {
    totalRecipes: recipes.length,
    probeRecipes: probes.map((probe) => ({ id: probe.id, name: probe.name })),
  });

  for (const probe of probes) {
    try {
      await client.deleteRecipe(probe.id);
      guard.log("deleted:", { recipeId: probe.id });
    } catch (error) {
      guard.log("delete FAILED, remove manually:", {
        recipeId: probe.id,
        error: describeError(guard, error),
      });
      process.exitCode = 1;
    }
  }

  const remaining = (await client.getRecipes()).filter((recipe) =>
    recipe.name.startsWith(PROBE_PREFIX),
  );

  // deleteRecipe() reports success and changes nothing (see 04). Anything left
  // here has to be removed by hand in the AnyList app.
  guard.log("after cleanup:", {
    probeRecipesRemaining: remaining.map((probe) => ({ id: probe.id, name: probe.name })),
  });
  if (remaining.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const guard = new OutputGuard();
  console.error("cleanup failed:", describeError(guard, error));
  process.exitCode = 1;
});
