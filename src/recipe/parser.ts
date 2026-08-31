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
  "- `alternateMeasurements` records additional measurements the source itself",
  "  states for that ingredient, usually in a parenthetical such as",
  "  \"400g (approx. 14 oz / 2 to 2.5 medium sweet potatoes)\".",
  "  - The first measurement on the line is the primary one and belongs in",
  "    `quantity` and `unit`. Every further measurement the source states goes",
  "    into `alternateMeasurements`, in the order the source lists them.",
  "  - Never calculate, convert, round, or infer an alternate. Only record one",
  "    the source literally wrote. If the source states a single measurement,",
  "    return null.",
  "  - Keep each alternate's `quantity` exactly as written: \"14\", \"2 to 2.5\",",
  "    \"1/3\", \"1½\". Put the explicit unit in `unit` (\"oz\", \"cup\"), or null",
  "    when the source gives none.",
  "  - `descriptor` holds only the remaining source words qualifying that one",
  "    alternate, such as \"sliced\", \"grated\", or \"medium sweet potatoes\".",
  "    Use null when there are none.",
  "  - A descriptor belongs to the alternate, not to the ingredient. Do not copy",
  "    it into `preparation`. \"100g mushrooms (approx. 3.5 oz / 1 cup sliced)\"",
  "    has `preparation` null and \"sliced\" on the alternate, because \"sliced\"",
  "    describes what a cup measures, not a step the cook was told to perform.",
  "  - `preparation` still captures a preparation the source states for the",
  "    ingredient itself, such as the \"minced\" in \"3 cloves garlic, minced\".",
  "- `instructions` must contain only steps stated in the source text, in order,",
  "  one step per array entry. Do not add preheating, resting, or serving steps",
  "  that the source text does not mention.",
  "- Populate `prepTime` and `cookTime` only when the source explicitly states",
  "  that duration. Otherwise return null.",
  "  - A single stated time goes in `minMinutes` with `maxMinutes` set to null.",
  "    \"40 minutes\" is {minMinutes: 40, maxMinutes: null}.",
  "  - A stated range puts the low end in `minMinutes` and the high end in",
  "    `maxMinutes`. \"35-40 minutes\" is {minMinutes: 35, maxMinutes: 40}.",
  "  - Never encode an exact time as a range where the two values are equal.",
  "- Never calculate a total by adding up individual step durations. Use a total",
  "  only when the source explicitly states one.",
  "- A duration attached to a single step, such as \"saute for 5 minutes\", stays",
  "  in that instruction. Do not promote it to `prepTime` or `cookTime` unless the",
  "  source clearly presents it as the recipe's prep or cook duration. A stated",
  "  baking or cooking duration such as \"bake at 350F for 35-40 minutes\" is the",
  "  cook time.",
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

/** An explicitly stated numeric duration, including ranges such as "35-40 minutes". */
const DURATION_PATTERN =
  /\b\d+(?:\s*(?:[-\u2010-\u2015~]|to)\s*\d+)?\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b/i;

/**
 * Reports whether an explicit duration survives anywhere in the extracted
 * recipe. Used only to keep warnings truthful — it never contributes a value to
 * the recipe itself.
 */
function mentionsDuration(extracted: ExtractedRecipe): boolean {
  const text = [extracted.description ?? "", ...extracted.instructions].join("\n");
  return DURATION_PATTERN.test(text);
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

  if (extracted.prepTime === null && extracted.cookTime === null) {
    // Only claim a time was absent if none appears in what we actually extracted.
    warnings.push(
      mentionsDuration(extracted)
        ? "A duration appears in the recipe text but was not captured as a structured prep or cook time."
        : "No prep or cook time was stated in the source text.",
    );
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
