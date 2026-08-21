import type { CreateRecipeOptions, Recipe } from "@anylist-napi/anylist-napi";
import { AnyListClient } from "@anylist-napi/anylist-napi";

import { OutputGuard } from "./lib/redact.js";
import { PROBE_PREFIX, describeError, guardTokens, readTokens } from "./lib/session.js";

/**
 * Experiment 5 — what survives a round trip through AnyList.
 *
 * Deliberately *updates* the existing probe recipe rather than creating a new
 * one: `deleteRecipe()` does not work (experiment 4), so every created recipe
 * is permanent. One probe, reused.
 *
 * Covers the fields the adapter maps, plus the awkward inputs a real caption
 * produces: unicode, emoji, en dashes, long strings, and empty optionals.
 */

const LONG_INGREDIENT = `Very long ingredient name ${"x".repeat(400)}`;

function payload(name: string): CreateRecipeOptions {
  return {
    name,
    ingredients: [
      { name: "Chicken thighs", quantity: "800 g", note: "boneless, skin on" },
      { name: "Chipotle en adobo", quantity: "2 tbsp" },
      { name: "Onion — white", quantity: "1", note: "thinly sliced 🔪" },
      { name: LONG_INGREDIENT, quantity: "1 pinch" },
      { name: "Salt" },
    ],
    preparationSteps: [
      "Sear the chicken over high heat.",
      "Blend the chipotle with the onion — do not over-blend.",
      "Simmer 35–40 minutes. 🍲",
    ],
    note: "Automated research probe.\nPrep time stated in source: 15 minutes\nCook time stated in source: 35–40 minutes",
    sourceName: "@a_creator",
    sourceUrl: "https://www.tiktok.com/@a_creator/video/1234567890",
    servings: "4",
    prepTime: 15,
    cookTime: 40,
    rating: 3,
    nutritionalInfo: "Not stated in source.",
  };
}

function compare(sent: CreateRecipeOptions, stored: Recipe): Record<string, unknown> {
  return {
    name: stored.name === sent.name,
    note: stored.note === sent.note,
    sourceName: stored.sourceName === sent.sourceName,
    sourceUrl: stored.sourceUrl === sent.sourceUrl,
    servings: stored.servings === sent.servings,
    rating: stored.rating === sent.rating,
    nutritionalInfo: stored.nutritionalInfo === sent.nutritionalInfo,
    prepTime: { sent: sent.prepTime, stored: stored.prepTime },
    cookTime: { sent: sent.cookTime, stored: stored.cookTime },
    ingredientCount: { sent: sent.ingredients.length, stored: stored.ingredients.length },
    ingredientsIdentical:
      JSON.stringify(stored.ingredients.map((i) => [i.name, i.quantity ?? null, i.note ?? null])) ===
      JSON.stringify(sent.ingredients.map((i) => [i.name, i.quantity ?? null, i.note ?? null])),
    longIngredientLength: {
      sent: LONG_INGREDIENT.length,
      stored: stored.ingredients.find((i) => i.name.startsWith("Very long"))?.name.length ?? null,
    },
    stepsIdentical: JSON.stringify(stored.preparationSteps) === JSON.stringify(sent.preparationSteps),
    unicodePreserved: stored.preparationSteps.some((step) => step.includes("35–40") && step.includes("🍲")),
  };
}

async function main(): Promise<void> {
  const guard = new OutputGuard();
  const tokens = readTokens();
  guardTokens(guard, tokens);

  const client = AnyListClient.fromTokens(tokens);
  const probe = (await client.getRecipes()).find((recipe) => recipe.name.startsWith(PROBE_PREFIX));

  if (probe === undefined) {
    guard.log("no probe recipe available; run 02-restore-in-fresh-process.ts first");
    process.exitCode = 1;
    return;
  }

  // updateRecipe cannot change the name, so the probe keeps its original one.
  const sent = payload(probe.name);

  try {
    const returned = await client.updateRecipe(probe.id, sent);
    guard.log("updateRecipe() returned (client-side echo, not a server read):", {
      prepTime: returned.prepTime,
      cookTime: returned.cookTime,
      servings: returned.servings,
      idUnchanged: returned.id === probe.id,
    });

    const stored = await client.getRecipeById(probe.id);
    guard.log("round trip, read back from AnyList:", compare(sent, stored));
  } catch (error) {
    guard.log("mapping probe FAILED:", describeError(guard, error));
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const guard = new OutputGuard();
  console.error("experiment failed:", describeError(guard, error));
  process.exitCode = 1;
});
