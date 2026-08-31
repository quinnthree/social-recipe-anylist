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
 * ADR-024 settled the scope question these tests used to raise. `RecipeSchema`
 * is a producer schema — it also validates model output — and is deliberately
 * NOT globally strict. The hardening applies to untrusted inbound consumer-API
 * data only, and lives in a separate schema at the endpoint.
 *
 * So the "PRODUCER SCHEMA" tests below are no longer gaps. They record what the
 * canonical schema deliberately permits, paired with the inbound suite in
 * tests/contract/inbound-hardening.ts that rejects the same values at the
 * boundary. Read the two together: each permissive test here has a rejecting
 * counterpart there.
 */

const VALID = {
  title: "Cottage Cheese Brownies",
  description: null,
  servings: 9,
  prepTime: null,
  cookTime: { minMinutes: 35, maxMinutes: 40 },
  ingredients: [
    {
      quantity: "16",
      unit: "oz",
      name: "cottage cheese",
      preparation: null,
      rawText: "16 oz cottage cheese",
      alternateMeasurements: null,
    },
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
    alternateMeasurements: null,
  };

  it("accepts the full six-field shape", () => {
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

  it("requires all six keys, including the nullable ones", () => {
    for (const field of [
      "quantity",
      "unit",
      "name",
      "preparation",
      "rawText",
      "alternateMeasurements",
    ]) {
      const copy: Record<string, unknown> = { ...ingredient };
      delete copy[field];

      expect(IngredientSchema.safeParse(copy).success).toBe(false);
    }
  });
});

describe("author-provided alternate measurements", () => {
  const ingredient = {
    quantity: "400",
    unit: "g",
    name: "Sweet potatoes",
    preparation: null,
    rawText: "Sweet potatoes — 400g (approx. 14 oz / 2 to 2.5 medium sweet potatoes)",
    alternateMeasurements: null as unknown,
  };

  const withAlternates = (alternateMeasurements: unknown) =>
    IngredientSchema.safeParse({ ...ingredient, alternateMeasurements });

  it("accepts null when the creator offered no alternate", () => {
    expect(withAlternates(null).success).toBe(true);
  });

  it("accepts a weight alternate and a descriptive count alternate together", () => {
    const parsed = withAlternates([
      { quantity: "14", unit: "oz", descriptor: null },
      { quantity: "2 to 2.5", unit: null, descriptor: "medium sweet potatoes" },
    ]);

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.alternateMeasurements).toEqual([
      { quantity: "14", unit: "oz", descriptor: null },
      { quantity: "2 to 2.5", unit: null, descriptor: "medium sweet potatoes" },
    ]);
  });

  it("keeps an alternate quantity as source text, never a parsed number", () => {
    // Same rule as the primary quantity: "2 to 2.5" and "1/3" are what the
    // creator wrote, and turning either into a number would be a calculation.
    for (const quantity of ["14", "2 to 2.5", "1/3", "3.5", "1½"]) {
      const parsed = withAlternates([{ quantity, unit: "oz", descriptor: null }]);

      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.alternateMeasurements?.[0]?.quantity).toBe(quantity);
    }
  });

  it("rejects a numeric alternate quantity", () => {
    expect(withAlternates([{ quantity: 14, unit: "oz", descriptor: null }]).success).toBe(false);
  });

  it("requires an alternate to state a quantity", () => {
    // A unit or descriptor with no amount is not a measurement.
    expect(withAlternates([{ quantity: "", unit: "oz", descriptor: null }]).success).toBe(false);
    expect(withAlternates([{ unit: "oz", descriptor: null }]).success).toBe(false);
  });

  it("requires unit and descriptor to be present as explicit nulls", () => {
    expect(withAlternates([{ quantity: "14", descriptor: null }]).success).toBe(false);
    expect(withAlternates([{ quantity: "14", unit: "oz" }]).success).toBe(false);
  });

  it("carries no provenance, calculated, or normalised-unit field", () => {
    // The type means one thing: the creator wrote this. There is no `kind`, no
    // `calculated` flag, and no unit enum, because nothing in the system may
    // produce an alternate that did not come from the source (B4-B).
    const parsed = withAlternates([{ quantity: "14", unit: "oz", descriptor: null }]);
    const alternate = parsed.success ? parsed.data.alternateMeasurements?.[0] : undefined;

    expect(Object.keys(alternate ?? {}).sort()).toEqual(["descriptor", "quantity", "unit"]);
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

  it("accepts minMinutes === maxMinutes, which ADR-024 makes legal inbound", () => {
    // "An exact time is never encoded as min === max" remains the PRODUCER
    // rule, enforced by the extraction prompt. ADR-024 accepts the shape on the
    // consumer side, so the schema permitting it is now correct rather than a
    // gap — see tests/contract/inbound-hardening.test.ts for the rendering
    // defect that acceptance exposes (QA-020).
    expect(TimeRangeSchema.safeParse({ minMinutes: 35, maxMinutes: 35 }).success).toBe(true);
  });

  it("PRODUCER SCHEMA: accepts an upper bound below the lower bound — rejected inbound", () => {
    // Nothing we produce can generate this. The inbound schema rejects it
    // (ADR-024 C); this one is not required to.
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

describe("PRODUCER SCHEMA — deliberately permissive, hardened at the boundary", () => {
  it("strips unknown keys instead of rejecting them, by design — QA-006", () => {
    // ADR-024: strictness belongs at the untrusted boundary, not everywhere.
    // Making this schema strict would churn the extraction pipeline for no
    // safety gain. The inbound schema rejects unknown keys; this one strips
    // them, which is harmless for model output.
    const parsed = RecipeSchema.safeParse({ ...VALID, clientOnlyField: "kept?" });

    expect(parsed.success).toBe(true);
    expect(parsed.success && "clientOnlyField" in parsed.data).toBe(false);
  });

  it("accepts a whitespace-only title; the inbound schema rejects it — QA-007", () => {
    // z.string().min(1) counts characters, not content. ADR-024 A hardens this
    // at the boundary. Note it hardens `title` only: `name`, `rawText`,
    // `quantity`, `unit`, `preparation`, and instruction steps all share the
    // weakness and are not covered (QA-023).
    expect(accepts({ ...VALID, title: "   " })).toBe(true);
    expect(accepts({ ...VALID, ingredients: [{ ...VALID.ingredients[0], name: "   " }] })).toBe(true);
  });

  it.each(["file:///etc/passwd", "javascript:alert(1)", "data:text/plain,x", "ftp://host/x"])(
    "accepts %s as source.url; the inbound schema rejects it — QA-008",
    (url) => {
      // z.string().url() accepts any parseable URL, not just http(s).
      // detectPlatform rejects these on the extraction path, so nothing today
      // can produce one. ADR-024 B restricts the inbound schema to http(s),
      // which is what protects the export path.
      expect(SourceSchema.safeParse({ platform: "tiktok", creator: null, url }).success).toBe(true);
    },
  );

  it("rejects a string that is not a URL at all", () => {
    expect(SourceSchema.safeParse({ platform: "tiktok", creator: null, url: "not a url" }).success).toBe(
      false,
    );
  });
});
