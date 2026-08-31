import { z } from "zod";

/**
 * Canonical platform values. YouTube is canonically supported but has no
 * ingestion adapter yet; see src/social/index.ts and docs/decisions.md ADR-015.
 */
export const PlatformSchema = z.enum(["tiktok", "instagram", "youtube"]);

/**
 * A second measurement the **creator themselves wrote** for an ingredient,
 * alongside the primary one — the `14 oz` and `2 to 2.5 medium sweet potatoes`
 * in `Sweet potatoes — 400g (approx. 14 oz / 2 to 2.5 medium sweet potatoes)`.
 *
 * This is a record of what the source said, never a conversion. Nothing
 * computes a value into this field: no unit conversion, no rounding, no density
 * table, no scaling. If the creator did not write it, it does not appear here.
 * That is the entire contract, and it is what lets a later Review projection
 * offer the author's own alternate without the application inventing numbers on
 * someone's behalf.
 *
 * `quantity` is source text, preserved as written — `"14"`, `"2 to 2.5"`,
 * `"1/3"`, `"1½"`. It is deliberately not parsed into a number, for the same
 * reason the primary `quantity` is not.
 *
 * `descriptor` holds the source words that qualify *this alternate* and nothing
 * else: the `sliced` in `1 cup sliced`, the `medium sweet potatoes` in
 * `2 to 2.5 medium sweet potatoes`. A descriptor is **not** promoted into
 * `Ingredient.preparation` — see the note there.
 */
export const AlternateMeasurementSchema = z.object({
  quantity: z.string().min(1),
  unit: z.string().min(1).nullable(),
  descriptor: z.string().min(1).nullable(),
});

/**
 * Optional fields are modelled as nullable rather than absent: an explicit
 * `null` records "this was not present in the source" and keeps the structured
 * output contract with the model unambiguous. Nothing is ever filled in.
 *
 * `preparation` describes how the *ingredient* is prepared, as the source
 * states it for the ingredient itself — the `minced` in
 * `3 cloves garlic, minced`. A cut word that appears inside an author's
 * alternate measurement is qualifying that measurement, not instructing the
 * cook: `1 cup sliced` says how much a cup of sliced mushrooms is, and
 * `100g mushrooms (approx. 3.5 oz / 1 cup sliced)` therefore leaves
 * `preparation` null and puts `sliced` on the alternate. Promoting it would
 * assert a prep step the creator never asked for.
 *
 * `alternateMeasurements` is `null` when the source offered none, and is never
 * an empty array from our own extraction. `rawText` remains the source line and
 * is never regenerated from these fields.
 */
export const IngredientSchema = z.object({
  quantity: z.string().min(1).nullable(),
  unit: z.string().min(1).nullable(),
  name: z.string().min(1),
  preparation: z.string().min(1).nullable(),
  rawText: z.string().min(1),
  alternateMeasurements: z.array(AlternateMeasurementSchema).nullable(),
});

/**
 * An explicitly stated duration. `maxMinutes` is null when the source states a
 * single time; it is only populated when the source states a range. An exact
 * time is never encoded as min === max.
 */
export const TimeRangeSchema = z.object({
  minMinutes: z.number().int().positive(),
  maxMinutes: z.number().int().positive().nullable(),
});

export const SourceSchema = z.object({
  platform: PlatformSchema,
  creator: z.string().min(1).nullable(),
  url: z.string().url(),
});

/**
 * The fields the model is allowed to produce. Everything outside this schema
 * (source, confidence, warnings) is derived deterministically in code so that
 * it cannot be invented.
 */
export const ExtractedRecipeSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1).nullable(),
  servings: z.number().int().positive().nullable(),
  prepTime: TimeRangeSchema.nullable(),
  cookTime: TimeRangeSchema.nullable(),
  ingredients: z.array(IngredientSchema),
  instructions: z.array(z.string().min(1)),
});

export const RecipeSchema = ExtractedRecipeSchema.extend({
  source: SourceSchema,
  confidence: z.number().min(0).max(1),
  warnings: z.array(z.string()),
});

export type Platform = z.infer<typeof PlatformSchema>;
export type TimeRange = z.infer<typeof TimeRangeSchema>;
export type AlternateMeasurement = z.infer<typeof AlternateMeasurementSchema>;
export type Ingredient = z.infer<typeof IngredientSchema>;
export type Source = z.infer<typeof SourceSchema>;
export type ExtractedRecipe = z.infer<typeof ExtractedRecipeSchema>;
export type Recipe = z.infer<typeof RecipeSchema>;
