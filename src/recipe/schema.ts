import { z } from "zod";

/**
 * Canonical platform values. YouTube is canonically supported but has no
 * ingestion adapter yet; see src/social/index.ts and docs/decisions.md ADR-015.
 */
export const PlatformSchema = z.enum(["tiktok", "instagram", "youtube"]);

/**
 * Optional fields are modelled as nullable rather than absent: an explicit
 * `null` records "this was not present in the source" and keeps the structured
 * output contract with the model unambiguous. Nothing is ever filled in.
 */
export const IngredientSchema = z.object({
  quantity: z.string().min(1).nullable(),
  unit: z.string().min(1).nullable(),
  name: z.string().min(1),
  preparation: z.string().min(1).nullable(),
  rawText: z.string().min(1),
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
export type Ingredient = z.infer<typeof IngredientSchema>;
export type Source = z.infer<typeof SourceSchema>;
export type ExtractedRecipe = z.infer<typeof ExtractedRecipeSchema>;
export type Recipe = z.infer<typeof RecipeSchema>;
