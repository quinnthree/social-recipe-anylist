import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildNote, toAnyListRecipe } from "../../src/anylist/mapping.js";
import { PlatformSchema, RecipeSchema, type Recipe } from "../../src/recipe/schema.js";
import { runInboundRecipeConformance, VALID_INBOUND_RECIPE } from "./inbound-hardening.js";

/**
 * Drives the inbound hardening conformance suite, and pins the rendering
 * contradiction ADR-024 created.
 *
 * The schema below is a REFERENCE IMPLEMENTATION. It exists to prove the suite
 * is satisfiable and to give the Backend agent a worked target; it is not
 * production code and must not be promoted into src/. The real one belongs at
 * the endpoint (ADR-024), applied to untrusted inbound bodies only.
 */

const httpsOnly = (url: string): boolean => {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

const InboundTimeRange = z
  .object({
    minMinutes: z.number().int().positive(),
    maxMinutes: z.number().int().positive().nullable(),
  })
  .strict()
  // Accepts min === max; rejects max < min (ADR-024 C).
  .refine((time) => time.maxMinutes === null || time.maxMinutes >= time.minMinutes, {
    message: "maxMinutes must not be below minMinutes",
  });

const InboundIngredient = z
  .object({
    quantity: z.string().min(1).nullable(),
    unit: z.string().min(1).nullable(),
    name: z.string().min(1),
    preparation: z.string().min(1).nullable(),
    rawText: z.string().min(1),
  })
  .strict();

const InboundSource = z
  .object({
    platform: PlatformSchema,
    creator: z.string().min(1).nullable(),
    url: z.string().url().refine(httpsOnly, { message: "only http and https are accepted" }),
  })
  .strict();

const InboundRecipe = z
  .object({
    // Rejects whitespace-only (ADR-024 A) without altering the stored value.
    title: z.string().refine((value) => value.trim().length > 0, { message: "title is blank" }),
    description: z.string().min(1).nullable(),
    servings: z.number().int().positive().nullable(),
    prepTime: InboundTimeRange.nullable(),
    cookTime: InboundTimeRange.nullable(),
    ingredients: z.array(InboundIngredient),
    instructions: z.array(z.string().min(1)),
    source: InboundSource,
    confidence: z.number().min(0).max(1),
    warnings: z.array(z.string()),
  })
  .strict();

const InboundExportBody = z
  .object({ schemaVersion: z.literal(1), recipe: InboundRecipe })
  .strict();

const accepts = (value: unknown): boolean => InboundExportBody.safeParse(value).success;

describe("inbound hardening conformance (reference schema)", () => {
  runInboundRecipeConformance(accepts);
});

describe("the inbound schema is strictly narrower than the canonical one", () => {
  // ADR-024: strictness at the untrusted boundary, not everywhere. These prove
  // the two schemas genuinely differ rather than one being a copy of the other.
  const canonical = (value: unknown) => RecipeSchema.safeParse(value).success;
  const inbound = (recipe: unknown) => accepts({ schemaVersion: 1, recipe });

  it.each([
    ["a whitespace-only title", { title: "   " }],
    ["a file: source url", { source: { ...VALID_INBOUND_RECIPE.source, url: "file:///etc/passwd" } }],
    ["an inverted time range", { cookTime: { minMinutes: 40, maxMinutes: 35 } }],
    ["an unknown recipe key", { nutritionScore: 8 }],
  ])("%s passes canonical validation but fails inbound", (_label, overrides) => {
    const recipe = { ...VALID_INBOUND_RECIPE, ...overrides };

    expect(canonical(recipe)).toBe(true);
    expect(inbound(recipe)).toBe(false);
  });

  it("leaves the canonical schema permissive on purpose", () => {
    // The canonical schema also validates model output, where stripping an
    // unknown key is harmless. Tightening it globally is what ADR-024 declines.
    expect(canonical({ ...VALID_INBOUND_RECIPE, modelScratchpad: "x" })).toBe(true);
  });
});

describe("exact-time mapping", () => {
  const withCookTime = (cookTime: Recipe["cookTime"]): Recipe => ({
    ...VALID_INBOUND_RECIPE,
    description: null,
    prepTime: null,
    cookTime,
  });

  it("renders { n, null } as an exact time", () => {
    expect(buildNote(withCookTime({ minMinutes: 40, maxMinutes: null }))).toBe(
      "Cook time stated in source: 40 minutes",
    );
  });

  it("renders { n, greater than n } as a range", () => {
    expect(buildNote(withCookTime({ minMinutes: 35, maxMinutes: 40 }))).toBe(
      "Cook time stated in source: 35–40 minutes",
    );
  });

  it("sends the same numeric cookTime for all three shapes", () => {
    // Only the note is wrong; the numeric field is the lower bound either way,
    // which for { n, n } is correct. The defect is presentational and reaches
    // the user's AnyList recipe.
    for (const cookTime of [
      { minMinutes: 40, maxMinutes: null },
      { minMinutes: 40, maxMinutes: 40 },
    ] as const) {
      expect(toAnyListRecipe(withCookTime(cookTime)).cookTime).toBe(40);
    }
  });

  it("our own extraction never produces the offending shape", () => {
    // The producer rule is unchanged: an exact time is emitted as
    // { n, null }. This defect is reachable only through the inbound path,
    // which is exactly why it appeared when the inbound shape was widened.
    for (const time of [VALID_INBOUND_RECIPE.prepTime, VALID_INBOUND_RECIPE.cookTime]) {
      if (time?.maxMinutes == null) continue;
      expect(time.maxMinutes).toBeGreaterThan(time.minMinutes);
    }
  });
});

/**
 * QA-020 RESOLVED. `describeTime` now treats a range as `maxMinutes > minMinutes`,
 * so the inbound-legal `{ n, n }` renders as an exact time. Activated 2026-08-21.
 */
describe("exact-time mapping — { n, n } is an exact time (ADR-024 resolution)", () => {
  const withCookTime = (cookTime: Recipe["cookTime"]): Recipe => ({
    ...VALID_INBOUND_RECIPE,
    description: null,
    prepTime: null,
    cookTime,
  });

  it("renders { n, n } as an exact time, not a range", () => {
    expect(buildNote(withCookTime({ minMinutes: 40, maxMinutes: 40 }))).toBe(
      "Cook time stated in source: 40 minutes",
    );
  });

  it("renders { n, n } and { n, null } identically", () => {
    // They mean the same thing. The user must not be able to tell which encoding
    // their client happened to send.
    expect(buildNote(withCookTime({ minMinutes: 40, maxMinutes: 40 }))).toBe(
      buildNote(withCookTime({ minMinutes: 40, maxMinutes: null })),
    );
  });

  it("still renders a genuine range as a range", () => {
    expect(buildNote(withCookTime({ minMinutes: 35, maxMinutes: 40 }))).toBe(
      "Cook time stated in source: 35–40 minutes",
    );
  });

  it("applies the same rule to prepTime", () => {
    const recipe: Recipe = {
      ...VALID_INBOUND_RECIPE,
      description: null,
      prepTime: { minMinutes: 15, maxMinutes: 15 },
      cookTime: null,
    };

    expect(buildNote(recipe)).toBe("Prep time stated in source: 15 minutes");
  });
});
