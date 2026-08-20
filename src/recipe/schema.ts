import { z } from "zod";

export const PlatformSchema = z.enum(["instagram", "tiktok"]);

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
  prepTimeMinutes: z.number().int().nonnegative().nullable(),
  cookTimeMinutes: z.number().int().nonnegative().nullable(),
  ingredients: z.array(IngredientSchema),
  instructions: z.array(z.string().min(1)),
});

export const RecipeSchema = ExtractedRecipeSchema.extend({
  source: SourceSchema,
  confidence: z.number().min(0).max(1),
  warnings: z.array(z.string()),
});

export type Platform = z.infer<typeof PlatformSchema>;
export type Ingredient = z.infer<typeof IngredientSchema>;
export type Source = z.infer<typeof SourceSchema>;
export type ExtractedRecipe = z.infer<typeof ExtractedRecipeSchema>;
export type Recipe = z.infer<typeof RecipeSchema>;
