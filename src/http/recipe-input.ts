import { z } from "zod";

import { PlatformSchema, type Recipe } from "../recipe/schema.js";

/**
 * The canonical Recipe as an **inbound** contract (ADR-007, ADR-024).
 *
 * This is deliberately a separate schema from `RecipeSchema` rather than a
 * tightened version of it. `src/recipe/schema.ts` describes what our extraction
 * produces; this describes what we are willing to accept from a client. The
 * security boundary is untrusted inbound data, and hardening belongs at that
 * boundary rather than being pushed through the whole extraction pipeline,
 * which would cause churn across parallel workstreams for no safety gain.
 *
 * Three rules apply throughout:
 *
 * - **Strict.** Unknown keys are rejected at every level, not just the top.
 * - **Semantically non-blank.** `min(1)` admits `"   "`, which is not
 *   meaningful text. Required text is trimmed and must survive trimming.
 * - **The nullable model is preserved.** `null` remains a meaningful "the
 *   source did not state this". What is rejected is a non-null value that
 *   carries no information.
 *
 * Accepted values are returned **trimmed**. That normalisation is what makes
 * the idempotency fingerprint stable across insignificant whitespace (ADR-018).
 */

/** Required text: trimmed, and non-blank after trimming. */
const requiredText = z.string().trim().min(1);

/**
 * Optional text: `null` is meaningful and preserved; a whitespace-only string
 * is not, and is rejected rather than silently coerced to `null` — coercion
 * would quietly change the recipe the client believed it was sending.
 */
const optionalText = requiredText.nullable();

/**
 * An author-provided alternate measurement, as an inbound value. Strict like
 * everything else here: an entry that invents a key, or carries a blank
 * `quantity`, is rejected rather than partially accepted.
 *
 * Total size is already bounded by the route's 64 KB body limit, so the array
 * needs no length cap of its own — one would be an invented contract rule.
 */
export const AlternateMeasurementInputSchema = z.strictObject({
  quantity: requiredText,
  unit: optionalText,
  descriptor: optionalText,
});

/**
 * `alternateMeasurements` is **additive and optional inbound**, which is what
 * makes a server-first rollout possible (B4-B).
 *
 * The backend ships before any iOS client knows the field exists, so an old
 * client's ingredient — which simply has no such key — must be accepted, not
 * rejected by the strict object it would otherwise violate. Absence normalises
 * to canonical `null`, the same value the field would carry if the client had
 * sent it explicitly, so the two clients produce byte-identical accepted
 * recipes.
 *
 * Absence is the *only* leniency. An explicit `null` is accepted, an array is
 * validated strictly entry by entry, and anything else fails.
 *
 * This deliberately does **not** bump `schemaVersion`. Version 2 exists to
 * announce a change an old client would get *wrong*; a field it never sends and
 * never reads is not one. Requiring version 2 here would force every existing
 * client to change in order to keep doing exactly what it already does.
 */
export const IngredientInputSchema = z.strictObject({
  quantity: optionalText,
  unit: optionalText,
  name: requiredText,
  preparation: optionalText,
  rawText: requiredText,
  alternateMeasurements: z.array(AlternateMeasurementInputSchema).nullable().default(null),
});

/**
 * `maxMinutes === minMinutes` is accepted, because a client edit can
 * legitimately produce it. `maxMinutes < minMinutes` is not a range, it is a
 * mistake.
 *
 * The preferred producer form for an exact time remains
 * `{ minMinutes: n, maxMinutes: null }`, and our own extraction still emits it.
 */
export const TimeRangeInputSchema = z
  .strictObject({
    minMinutes: z.number().int().positive(),
    maxMinutes: z.number().int().positive().nullable(),
  })
  .refine(({ minMinutes, maxMinutes }) => maxMinutes === null || maxMinutes >= minMinutes, {
    message: "maxMinutes must not be less than minMinutes",
  });

/**
 * `http:` and `https:` only. The canonical schema's `.url()` admits any scheme
 * with a valid shape, and this value is handed to the AnyList adapter as a
 * source URL — a `javascript:` or `file:` scheme has no business reaching it.
 */
export const SourceInputSchema = z.strictObject({
  platform: PlatformSchema,
  creator: optionalText,
  url: z
    .string()
    .trim()
    .refine(isHttpUrl, { message: "url must be an http or https URL" }),
});

export const RecipeInputSchema = z.strictObject({
  title: requiredText,
  description: optionalText,
  servings: z.number().int().positive().nullable(),
  prepTime: TimeRangeInputSchema.nullable(),
  cookTime: TimeRangeInputSchema.nullable(),
  ingredients: z.array(IngredientInputSchema),
  instructions: z.array(requiredText),
  source: SourceInputSchema,
  confidence: z.number().min(0).max(1),
  warnings: z.array(z.string()),
});

export type RecipeInput = z.infer<typeof RecipeInputSchema>;

/**
 * Compile-time proof that an accepted input really is a canonical Recipe. If
 * the canonical schema ever gains a field, this stops compiling rather than
 * letting the two shapes drift apart silently.
 */
const _acceptedIsCanonical: (input: RecipeInput) => Recipe = (input) => input;
void _acceptedIsCanonical;

/**
 * Shared by the export route's `source.url` and the import route's submitted
 * URL, so one rule governs every URL we accept from a client.
 */
export function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
