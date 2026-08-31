import { describe, expect, it } from "vitest";

import { fingerprintOf } from "./fingerprint.js";
import { forFingerprint } from "./recipe-fingerprint.js";
import { RecipeInputSchema } from "./recipe-input.js";

/**
 * Cross-deploy idempotency: a recipe with no author alternates must fingerprint
 * exactly as it did before `alternateMeasurements` existed.
 *
 * The hashes below are not expectations written to match the current code. They
 * were **captured from the pre-B4-B build** — `main` at 046c407, before any file
 * in this change was touched — by validating the same old-client bodies through
 * the then-current `RecipeInputSchema` and hashing
 * `{ schemaVersion: 1, recipe }`. That makes them a record of deployed
 * behaviour rather than a restatement of present behaviour, which is the only
 * thing that can actually prove a stored `idem:v1` record is still addressable.
 *
 * If a future change breaks these, it has silently invalidated every
 * fingerprint in production. That is the alarm they exist to raise.
 */

/** Captured pre-B4-B. Two ingredients, both alternate-free. */
const LEGACY_SWEET_POTATO = "5bbc07c35e8696aa65e5b5ca4107d56342f566aa317f91d5e0b06879956e77b7";

/** Captured pre-B4-B. The corpus reference recipe. */
const LEGACY_BROWNIES = "b0ed7193a75baeaa228856b537ec06f76994505894ff67f413850da8ed00365e";

/**
 * Exactly what a client built before B4-B sends: ingredients with no
 * `alternateMeasurements` key at all. Typed as `unknown` on purpose — this is
 * an old wire body, not a current `RecipeInput`, and it must not silently
 * acquire the new field just because TypeScript now knows about it.
 */
const OLD_CLIENT_SWEET_POTATO: unknown = {
  title: "Sweet Potato Tart",
  description: null,
  servings: 4,
  prepTime: null,
  cookTime: { minMinutes: 35, maxMinutes: null },
  ingredients: [
    {
      quantity: "400",
      unit: "g",
      name: "Sweet potatoes",
      preparation: null,
      rawText: "Sweet potatoes — 400g (approx. 14 oz / 2 to 2.5 medium sweet potatoes)",
    },
    {
      quantity: "100",
      unit: "g",
      name: "Mushrooms",
      preparation: null,
      rawText: "Mushrooms — 100g (approx. 3.5 oz / 1 cup sliced)",
    },
  ],
  instructions: ["Mash the cooked potatoes and press into the pan."],
  source: {
    platform: "instagram",
    creator: "firsttakehadrian",
    url: "https://www.instagram.com/reel/Db04u1qCEqD/",
  },
  confidence: 0.9,
  warnings: [],
};

const OLD_CLIENT_BROWNIES: unknown = {
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
    },
  ],
  instructions: ["Blend until smooth."],
  source: {
    platform: "tiktok",
    creator: "creator",
    url: "https://www.tiktok.com/@creator/video/7123456789",
  },
  confidence: 0.9,
  warnings: ["No servings were stated in the source text."],
};

/** The route's fingerprint, end to end: validate, normalise, hash. */
function fingerprintFor(body: unknown): string {
  const parsed = RecipeInputSchema.parse(body);
  return fingerprintOf({ schemaVersion: 1, recipe: forFingerprint(parsed) });
}

/** Replaces every ingredient's alternates, to compare equivalent expressions. */
function withAlternatesOnEvery(body: unknown, value: unknown): unknown {
  const recipe = body as { ingredients: Record<string, unknown>[] };
  return {
    ...recipe,
    ingredients: recipe.ingredients.map((i) => ({ ...i, alternateMeasurements: value })),
  };
}

describe("A. legacy fingerprint behaviour, captured before B4-B", () => {
  it("an old client's body still hashes to its pre-deploy fingerprint", () => {
    expect(fingerprintFor(OLD_CLIENT_SWEET_POTATO)).toBe(LEGACY_SWEET_POTATO);
    expect(fingerprintFor(OLD_CLIENT_BROWNIES)).toBe(LEGACY_BROWNIES);
  });

  it("proves the pinned hashes are not vacuous", () => {
    // A recipe that differs by one character must not match, or the assertions
    // above would pass for the wrong reason.
    const edited = { ...(OLD_CLIENT_BROWNIES as object), servings: 8 };

    expect(fingerprintFor(edited)).not.toBe(LEGACY_BROWNIES);
  });
});

describe("B. empty alternate metadata is fingerprint-neutral", () => {
  it.each([
    ["absent (old client)", undefined],
    ["explicit null", null],
    ["empty array", []],
  ])("%s hashes as the pre-B4-B recipe", (_label, value) => {
    const body =
      value === undefined
        ? OLD_CLIENT_SWEET_POTATO
        : withAlternatesOnEvery(OLD_CLIENT_SWEET_POTATO, value);

    expect(fingerprintFor(body)).toBe(LEGACY_SWEET_POTATO);
  });

  it("treats all three ways of saying nothing as one request", () => {
    const asNull = fingerprintFor(withAlternatesOnEvery(OLD_CLIENT_BROWNIES, null));
    const asEmpty = fingerprintFor(withAlternatesOnEvery(OLD_CLIENT_BROWNIES, []));

    // A client that upgrades mid-retry — omitting the field, then sending null,
    // then sending [] — must not conflict with itself.
    expect(asNull).toBe(fingerprintFor(OLD_CLIENT_BROWNIES));
    expect(asEmpty).toBe(asNull);
  });
});

describe("C. real alternates do change the fingerprint", () => {
  const withRealAlternates = withAlternatesOnEvery(OLD_CLIENT_BROWNIES, [
    { quantity: "450", unit: "g", descriptor: null },
  ]);

  it("a recipe carrying author alternates is a different request", () => {
    expect(fingerprintFor(withRealAlternates)).not.toBe(LEGACY_BROWNIES);
  });

  it("distinguishes two different alternates", () => {
    const other = withAlternatesOnEvery(OLD_CLIENT_BROWNIES, [
      { quantity: "450", unit: "g", descriptor: "drained" },
    ]);

    expect(fingerprintFor(other)).not.toBe(fingerprintFor(withRealAlternates));
  });

  it("preserves alternate order, because order is what the creator wrote", () => {
    const forward = withAlternatesOnEvery(OLD_CLIENT_BROWNIES, [
      { quantity: "14", unit: "oz", descriptor: null },
      { quantity: "2", unit: null, descriptor: "medium" },
    ]);
    const reversed = withAlternatesOnEvery(OLD_CLIENT_BROWNIES, [
      { quantity: "2", unit: null, descriptor: "medium" },
      { quantity: "14", unit: "oz", descriptor: null },
    ]);

    expect(fingerprintFor(forward)).not.toBe(fingerprintFor(reversed));
  });
});

describe("D. the normalisation itself", () => {
  it("omits an empty field rather than nulling it", () => {
    // `canonicalise` encodes undefined as null, so setting the key to undefined
    // would hash identically to an explicit null and defeat the whole purpose.
    // The key has to be genuinely absent.
    const parsed = RecipeInputSchema.parse(OLD_CLIENT_SWEET_POTATO);
    const normalised = forFingerprint(parsed) as { ingredients: Record<string, unknown>[] };

    for (const ingredient of normalised.ingredients) {
      expect(Object.hasOwn(ingredient, "alternateMeasurements")).toBe(false);
    }
  });

  it("keeps the key when the ingredient carries real alternates", () => {
    const parsed = RecipeInputSchema.parse(
      withAlternatesOnEvery(OLD_CLIENT_SWEET_POTATO, [
        { quantity: "14", unit: "oz", descriptor: null },
      ]),
    );
    const normalised = forFingerprint(parsed) as { ingredients: Record<string, unknown>[] };

    for (const ingredient of normalised.ingredients) {
      expect(Object.hasOwn(ingredient, "alternateMeasurements")).toBe(true);
    }
  });

  it("normalises per ingredient, not per recipe", () => {
    // One ingredient with alternates must not drag the empty ones into the hash.
    const parsed = RecipeInputSchema.parse(OLD_CLIENT_SWEET_POTATO) as {
      ingredients: Record<string, unknown>[];
    };
    parsed.ingredients[0]!["alternateMeasurements"] = [
      { quantity: "14", unit: "oz", descriptor: null },
    ];

    const normalised = forFingerprint(parsed as never) as {
      ingredients: Record<string, unknown>[];
    };

    expect(Object.hasOwn(normalised.ingredients[0]!, "alternateMeasurements")).toBe(true);
    expect(Object.hasOwn(normalised.ingredients[1]!, "alternateMeasurements")).toBe(false);
  });

  it("changes nothing else about the recipe", () => {
    const parsed = RecipeInputSchema.parse(OLD_CLIENT_SWEET_POTATO);
    const normalised = forFingerprint(parsed) as Record<string, unknown>;

    const { ingredients: _dropped, ...restOfNormalised } = normalised;
    const { ingredients: _also, ...restOfParsed } = parsed as unknown as Record<string, unknown>;

    expect(restOfNormalised).toEqual(restOfParsed);
  });

  it("does not mutate the validated recipe it was given", () => {
    // The route hands the same object to `exportRecipe` afterwards.
    const parsed = RecipeInputSchema.parse(OLD_CLIENT_SWEET_POTATO);
    forFingerprint(parsed);

    expect(parsed.ingredients[0]?.alternateMeasurements).toBeNull();
  });
});

describe("E. what would have broken without the normalisation", () => {
  it("hashing the accepted recipe directly would have shifted every fingerprint", () => {
    // Documents the defect this module prevents. Fingerprinting the validated
    // recipe as-is — the obvious implementation — puts
    // `"alternateMeasurements":null` into the serialisation of every recipe
    // ever exported, so no pre-deploy record could be found again.
    const parsed = RecipeInputSchema.parse(OLD_CLIENT_SWEET_POTATO);
    const naive = fingerprintOf({ schemaVersion: 1, recipe: parsed });

    expect(naive).not.toBe(LEGACY_SWEET_POTATO);
  });
});
