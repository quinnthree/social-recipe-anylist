import { describe, expect, it } from "vitest";

import { detectPlatform } from "../../src/social/index.js";
import { ExtractionError } from "../../src/social/types.js";
import {
  IngredientSchema,
  PlatformSchema,
  RecipeSchema,
  SourceSchema,
  TimeRangeSchema,
} from "../../src/recipe/schema.js";

/**
 * The canonical Recipe contract, tested independently of the pipeline that
 * produces it.
 *
 * Today the canonical Recipe is only ever a server *output*. ADR-007 makes it
 * an *inbound* contract at POST /api/exports/anylist. Several tests below are
 * marked "INBOUND GAP": they assert what the schema does today, which is safe
 * while we are the only producer and is not safe once a client can submit one.
 * Each names an entry in docs/qa/findings.md. None of them is a defect in the
 * current shipped behaviour.
 */

const VALID = {
  title: "Cottage Cheese Brownies",
  description: null,
  servings: 9,
  prepTime: null,
  cookTime: { minMinutes: 35, maxMinutes: 40 },
  ingredients: [
    { quantity: "16", unit: "oz", name: "cottage cheese", preparation: null, rawText: "16 oz cottage cheese" },
  ],
  instructions: ["Blend until smooth."],
  source: {
    platform: "tiktok",
    creator: "proteinbakes",
    url: "https://www.tiktok.com/@proteinbakes/video/7311111111111111111",
  },
  confidence: 0.9,
  warnings: [],
};

const accepts = (value: unknown) => RecipeSchema.safeParse(value).success;
const without = (field: string) => {
  const copy: Record<string, unknown> = { ...VALID };
  delete copy[field];
  return copy;
};

describe("required fields", () => {
  it.each(["title", "ingredients", "instructions", "source", "confidence", "warnings"])(
    "rejects a recipe with no %s",
    (field) => {
      expect(accepts(without(field))).toBe(false);
    },
  );

  it.each(["description", "servings", "prepTime", "cookTime"])(
    "requires %s to be present as an explicit null, never omitted",
    (field) => {
      // The contract says optional values are explicit null, never absent.
      // Nullable-but-required is what enforces that.
      expect(accepts(without(field))).toBe(false);
      expect(accepts({ ...VALID, [field]: null })).toBe(true);
    },
  );

  it("requires source.creator to be present as an explicit null", () => {
    expect(SourceSchema.safeParse({ platform: "tiktok", url: VALID.source.url }).success).toBe(false);
    expect(
      SourceSchema.safeParse({ platform: "tiktok", creator: null, url: VALID.source.url }).success,
    ).toBe(true);
  });
});

describe("field constraints", () => {
  it("rejects an empty title", () => {
    expect(accepts({ ...VALID, title: "" })).toBe(false);
  });

  it("rejects a non-positive or fractional servings", () => {
    for (const servings of [0, -1, 2.5]) {
      expect(accepts({ ...VALID, servings })).toBe(false);
    }
  });

  it("rejects confidence outside 0..1, and NaN", () => {
    for (const confidence of [-0.1, 1.1, Number.NaN]) {
      expect(accepts({ ...VALID, confidence })).toBe(false);
    }
    expect(accepts({ ...VALID, confidence: 0 })).toBe(true);
    expect(accepts({ ...VALID, confidence: 1 })).toBe(true);
  });

  it("rejects an empty instruction step", () => {
    expect(accepts({ ...VALID, instructions: ["Blend.", ""] })).toBe(false);
  });

  it("accepts an empty ingredients and instructions array", () => {
    // Required: the model must return empty arrays rather than guess when the
    // text is not a recipe, and assessExtraction turns that into warnings.
    expect(accepts({ ...VALID, ingredients: [], instructions: [] })).toBe(true);
  });

  it("rejects a non-string warning", () => {
    expect(accepts({ ...VALID, warnings: [42] })).toBe(false);
  });
});

describe("ingredient structure", () => {
  const ingredient = {
    quantity: "16",
    unit: "oz",
    name: "cottage cheese",
    preparation: null,
    rawText: "16 oz cottage cheese",
  };

  it("accepts the full five-field shape", () => {
    expect(IngredientSchema.safeParse(ingredient).success).toBe(true);
  });

  it("requires a non-empty name and rawText", () => {
    expect(IngredientSchema.safeParse({ ...ingredient, name: "" }).success).toBe(false);
    expect(IngredientSchema.safeParse({ ...ingredient, rawText: "" }).success).toBe(false);
  });

  it("distinguishes an absent quantity from an empty one", () => {
    // null means "the source did not state it". "" means nothing at all and is
    // rejected, so an absent quantity can never be silently stringified.
    expect(IngredientSchema.safeParse({ ...ingredient, quantity: null }).success).toBe(true);
    expect(IngredientSchema.safeParse({ ...ingredient, quantity: "" }).success).toBe(false);
  });

  it("keeps quantity as a string so fractions and ranges survive", () => {
    for (const quantity of ["1/2", "2-3", "2 1/2", "a handful"]) {
      const parsed = IngredientSchema.safeParse({ ...ingredient, quantity });

      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.quantity).toBe(quantity);
    }
  });

  it("requires all five keys, including the nullable ones", () => {
    for (const field of ["quantity", "unit", "name", "preparation", "rawText"]) {
      const copy: Record<string, unknown> = { ...ingredient };
      delete copy[field];

      expect(IngredientSchema.safeParse(copy).success).toBe(false);
    }
  });
});

describe("TimeRange semantics", () => {
  it("accepts an exact time as minMinutes with maxMinutes null", () => {
    expect(TimeRangeSchema.parse({ minMinutes: 40, maxMinutes: null })).toEqual({
      minMinutes: 40,
      maxMinutes: null,
    });
  });

  it("accepts a stated range across both bounds", () => {
    expect(TimeRangeSchema.parse({ minMinutes: 35, maxMinutes: 40 })).toEqual({
      minMinutes: 35,
      maxMinutes: 40,
    });
  });

  it("requires positive integer minutes", () => {
    for (const minMinutes of [0, -5, 12.5]) {
      expect(TimeRangeSchema.safeParse({ minMinutes, maxMinutes: null }).success).toBe(false);
    }
  });

  it("requires maxMinutes to be stated, even as null", () => {
    expect(TimeRangeSchema.safeParse({ minMinutes: 40 }).success).toBe(false);
  });

  it("INBOUND GAP: accepts minMinutes === maxMinutes, which the contract forbids — QA-004", () => {
    // "An exact time is never encoded as min === max" is enforced only by the
    // extraction prompt. The schema does not express it, so a client-supplied
    // recipe could carry {35, 35} and validate.
    expect(TimeRangeSchema.safeParse({ minMinutes: 35, maxMinutes: 35 }).success).toBe(true);
  });

  it("INBOUND GAP: accepts an upper bound below the lower bound — QA-004", () => {
    expect(TimeRangeSchema.safeParse({ minMinutes: 40, maxMinutes: 35 }).success).toBe(true);
  });
});

describe("source.platform", () => {
  it("is exactly the canonical vocabulary, in contract order", () => {
    // A frozen cross-boundary contract (ADR-008). Changing it must break a test.
    expect(PlatformSchema.options).toEqual(["tiktok", "instagram", "youtube"]);
  });

  it.each(["tiktok", "instagram", "youtube"])("accepts %s", (platform) => {
    expect(accepts({ ...VALID, source: { ...VALID.source, platform } })).toBe(true);
  });

  it.each([["pinterest"], ["TikTok"], ["Instagram"], [""], ["youtube.com"]])(
    "rejects %s strictly",
    (platform) => {
      expect(accepts({ ...VALID, source: { ...VALID.source, platform } })).toBe(false);
    },
  );

  it("rejects a null or missing platform", () => {
    expect(accepts({ ...VALID, source: { ...VALID.source, platform: null } })).toBe(false);
    expect(accepts({ ...VALID, source: { creator: null, url: VALID.source.url } })).toBe(false);
  });
});

describe("the social layer implements a subset of the canonical vocabulary", () => {
  const INGESTIBLE = ["tiktok", "instagram"] as const;

  it("ingests every canonical platform except youtube", () => {
    const canonicalOnly = PlatformSchema.options.filter(
      (platform) => !INGESTIBLE.includes(platform as (typeof INGESTIBLE)[number]),
    );

    expect(canonicalOnly).toEqual(["youtube"]);
  });

  it.each([
    ["https://www.tiktok.com/@creator/video/7123456789", "tiktok"],
    ["https://www.instagram.com/reel/Cxyz123/", "instagram"],
  ] as const)("routes %s to the %s adapter", (url, platform) => {
    expect(detectPlatform(url)).toBe(platform);
  });

  it("accepts youtube canonically while refusing to ingest it", () => {
    // ADR-015: canonical support and ingestion are separate facts. Both halves
    // are asserted together so neither can drift without the other noticing.
    expect(accepts({ ...VALID, source: { ...VALID.source, platform: "youtube" } })).toBe(true);

    const error = (() => {
      try {
        detectPlatform("https://www.youtube.com/watch?v=abc");
        return null;
      } catch (thrown: unknown) {
        return thrown as ExtractionError;
      }
    })();

    expect(error).toBeInstanceOf(ExtractionError);
    expect(error?.code).toBe("unsupported_platform");
  });
});

describe("INBOUND GAPS — safe today, load-bearing once a client can submit a Recipe", () => {
  it("strips unknown keys instead of rejecting them — QA-006", () => {
    // ADR-011 requires strict inbound validation: "Unknown keys are rejected,
    // not ignored." RecipeSchema is not .strict(), so a client field would be
    // silently dropped and the client would never learn the server ignored it.
    // The fix belongs at the endpoint, not in this shared schema.
    const parsed = RecipeSchema.safeParse({ ...VALID, clientOnlyField: "kept?" });

    expect(parsed.success).toBe(true);
    expect(parsed.success && "clientOnlyField" in parsed.data).toBe(false);
  });

  it("accepts a whitespace-only title — QA-007", () => {
    // z.string().min(1) counts characters, not content. A recipe titled " "
    // would be exported to AnyList under that name.
    expect(accepts({ ...VALID, title: "   " })).toBe(true);
  });

  it.each(["file:///etc/passwd", "javascript:alert(1)", "data:text/plain,x", "ftp://host/x"])(
    "accepts %s as source.url — QA-008",
    (url) => {
      // z.string().url() accepts any parseable URL, not just http(s).
      // detectPlatform rejects these on the extraction path, so nothing today
      // can produce one. On the export path there is no detectPlatform, and
      // source.url is written straight into the AnyList recipe's sourceUrl.
      expect(SourceSchema.safeParse({ platform: "tiktok", creator: null, url }).success).toBe(true);
    },
  );

  it("rejects a string that is not a URL at all", () => {
    expect(SourceSchema.safeParse({ platform: "tiktok", creator: null, url: "not a url" }).success).toBe(
      false,
    );
  });
});
