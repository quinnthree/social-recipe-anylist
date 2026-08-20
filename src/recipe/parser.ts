import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import type { SourceContent } from "../social/types.js";
import {
  ExtractedRecipeSchema,
  RecipeSchema,
  type ExtractedRecipe,
  type Recipe,
} from "./schema.js";

const MODEL = "claude-sonnet-5";
const MAX_TOKENS = 16_000;

/** Below this, the caption is almost certainly too thin to hold a full recipe. */
const THIN_SOURCE_CHARS = 80;

const SYSTEM_PROMPT = [
  "You extract structured recipes from social media captions.",
  "",
  "Rules:",
  "- Use only information that is literally present in the source text.",
  "- Never invent or infer quantities, units, temperatures, times, or servings.",
  "  If a value is not stated, return null for it.",
  "- Do not convert units, scale quantities, or normalise fractions. Keep the",
  "  quantity exactly as written (for example \"1/2\", \"2-3\", \"a handful\").",
  "- `rawText` must be the ingredient line as it appears in the source text.",
  "- `instructions` must contain only steps stated in the source text, in order,",
  "  one step per array entry. Do not add preheating, resting, or serving steps",
  "  that the source text does not mention.",
  "- `title` should be the dish name as stated in the source. If no dish name is",
  "  stated, use a short literal description of the dish drawn from the text.",
  "- If the text is not a recipe, return an empty ingredients array and an empty",
  "  instructions array rather than guessing.",
].join("\n");

/**
 * Turns extracted source text into a validated Recipe.
 *
 * The model produces only the recipe fields. `source`, `confidence`, and
 * `warnings` are attached afterwards from data we control, so they cannot be
 * hallucinated.
 */
export async function parseRecipe(content: SourceContent): Promise<Recipe> {
  const extracted = await extractRecipeFields(content);
  const { confidence, warnings } = assessExtraction(extracted, content);

  return RecipeSchema.parse({
    ...extracted,
    source: {
      platform: content.platform,
      creator: content.creator,
      url: content.url,
    },
    confidence,
    warnings,
  });
}

async function extractRecipeFields(content: SourceContent): Promise<ExtractedRecipe> {
  const client = createClient();

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Extract the recipe from this ${content.platform} post's text:\n\n${content.text}`,
      },
    ],
    output_config: { format: zodOutputFormat(ExtractedRecipeSchema) },
  });

  if (response.parsed_output === null) {
    throw new Error(
      `The model did not return a parseable recipe (stop reason: ${response.stop_reason ?? "unknown"}).`,
    );
  }

  // Re-validate on our side: structured output constrains the model, it does
  // not replace validation of data crossing into our domain.
  return ExtractedRecipeSchema.parse(response.parsed_output);
}

function createClient(): Anthropic {
  try {
    return new Anthropic();
  } catch {
    throw new Error(
      "No Anthropic credentials found. Set ANTHROPIC_API_KEY in your .env file (see .env.example).",
    );
  }
}

/**
 * Derives confidence and warnings from what was actually extracted. Entirely
 * deterministic — the model has no say in either value.
 */
export function assessExtraction(
  extracted: ExtractedRecipe,
  content: SourceContent,
): { confidence: number; warnings: string[] } {
  const warnings: string[] = [];
  let confidence = 1;

  if (extracted.ingredients.length === 0) {
    warnings.push("No ingredients were found in the source text.");
    confidence -= 0.4;
  }

  if (extracted.instructions.length === 0) {
    warnings.push("No instructions were found in the source text.");
    confidence -= 0.3;
  }

  const unquantified = extracted.ingredients.filter((i) => i.quantity === null).length;
  if (unquantified > 0) {
    warnings.push(
      `${unquantified} of ${extracted.ingredients.length} ingredients have no quantity in the source text.`,
    );
    if (unquantified * 2 > extracted.ingredients.length) confidence -= 0.1;
  }

  if (extracted.servings === null) {
    warnings.push("No servings were stated in the source text.");
    confidence -= 0.05;
  }

  if (extracted.prepTimeMinutes === null && extracted.cookTimeMinutes === null) {
    warnings.push("No prep or cook time was stated in the source text.");
    confidence -= 0.05;
  }

  if (content.textSource === "og-description") {
    warnings.push(
      "Recipe was extracted from Open Graph metadata, which is often a truncated version of the caption.",
    );
    confidence -= 0.1;
  }

  if (content.text.length < THIN_SOURCE_CHARS) {
    warnings.push(`Source text was only ${content.text.length} characters long.`);
    confidence -= 0.1;
  }

  if (content.creator === null) {
    warnings.push("The source creator could not be determined.");
  }

  return {
    confidence: Math.round(Math.min(1, Math.max(0, confidence)) * 100) / 100,
    warnings,
  };
}
