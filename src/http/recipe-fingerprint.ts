import type { AlternateMeasurement } from "../recipe/schema.js";
import type { RecipeInput } from "./recipe-input.js";

/**
 * Makes empty author-alternate metadata invisible to the request fingerprint.
 *
 * `fingerprintOf` hashes the *accepted, normalised* request (ADR-018), so every
 * key present in the accepted recipe is part of the hash — including a key
 * whose only value is "the client said nothing". Adding
 * `alternateMeasurements` to `IngredientInputSchema` would therefore have
 * changed the fingerprint of **every recipe that has no alternates at all**,
 * which is almost all of them.
 *
 * That would have been a silent, one-way break at the exact moment of
 * deployment. A client that exported before the deploy, timed out, and retried
 * with the same `Idempotency-Key` afterwards would have presented an unchanged
 * recipe against a changed hash, been told `409 Idempotency key conflict`, and
 * had no way to diagnose or fix it. The record it needed was still there and
 * still correct; only our serialisation had moved. The same shift would have
 * hidden every stored `IN_PROGRESS` and `AMBIGUOUS` record from the retry it
 * exists to stop, turning the safe answer into a duplicate write.
 *
 * The fix is to hash what the recipe *says*, not how many fields it now has:
 * absent, `null`, and `[]` all mean "this creator offered no alternate", so all
 * three are normalised to the same thing — an omitted key, exactly as a pre-B4
 * recipe serialised. A recipe carrying real alternates does hash differently,
 * and should: it is a different recipe.
 *
 * This is why no key-namespace bump, no `v2` route, and no `schemaVersion` 2
 * are needed. Existing `idem:v1` records stay addressable because their
 * fingerprints are genuinely unchanged, not because we versioned around them.
 *
 * Note the key is **omitted**, never set to `undefined`: `canonicalise`
 * deliberately encodes `undefined` as `null`, so an undefined value would hash
 * as `"alternateMeasurements":null` and defeat the whole point.
 */
export function forFingerprint(recipe: RecipeInput): unknown {
  return { ...recipe, ingredients: recipe.ingredients.map(withoutEmptyAlternates) };
}

type IngredientInput = RecipeInput["ingredients"][number];

function withoutEmptyAlternates(ingredient: IngredientInput): unknown {
  const { alternateMeasurements, ...rest } = ingredient;

  return isFingerprintNeutral(alternateMeasurements) ? rest : ingredient;
}

/** No alternate information, however the client chose to express its absence. */
function isFingerprintNeutral(alternates: AlternateMeasurement[] | null): boolean {
  return alternates === null || alternates.length === 0;
}
