import type { GoldenFixture } from "./types.js";

/**
 * The golden recipe corpus.
 *
 * Each entry records one recorded upstream response and the canonical Recipe it
 * must turn into, so that extraction quality has a fixed benchmark rather than
 * an anecdote. See docs/qa/README.md for the structure and how to add one.
 *
 * Nothing here makes a live call. The TikTok and Instagram payloads in
 * ./sources are recorded shapes served through a stubbed `fetch`.
 */

const COTTAGE_CHEESE_BROWNIES: GoldenFixture = {
  id: "tiktok-cottage-cheese-brownies",
  summary: "Complete TikTok recipe with a stated cook-time range. The known live success.",
  quality: "ZERO_EDIT_EXPECTED",
  url: "https://www.tiktok.com/@proteinbakes/video/7311111111111111111",
  recordedSource: {
    kind: "tiktok-oembed",
    status: 200,
    file: "tiktok-cottage-cheese-brownies.oembed.json",
  },
  expectedSourceContent: {
    platform: "tiktok",
    url: "https://www.tiktok.com/@proteinbakes/video/7311111111111111111",
    creator: "proteinbakes",
    text:
      "COTTAGE CHEESE BROWNIES \u{1F36B} you'd never guess these are high protein\n\n" +
      "Ingredients:\n16 oz cottage cheese\n1/2 cup cocoa powder\n1/2 cup maple syrup\n2 eggs\n" +
      "1/4 cup oat flour\n1 tsp baking powder\n1/2 tsp salt\n1/2 cup chocolate chips\n\n" +
      "Instructions:\n1. Preheat the oven to 350°F (175°C).\n" +
      "2. Blend the cottage cheese, cocoa powder, maple syrup and eggs until completely smooth.\n" +
      "3. Fold in the oat flour, baking powder and salt.\n" +
      "4. Pour into a lined 8x8 pan and top with the chocolate chips.\n" +
      "5. Bake for 35-40 minutes, until the centre is just set.\n" +
      "6. Cool completely before slicing.\n\nMakes 9 brownies.",
    textSource: "caption",
  },
  expectedExtraction: {
    title: "Cottage Cheese Brownies",
    description: null,
    servings: 9,
    prepTime: null,
    cookTime: { minMinutes: 35, maxMinutes: 40 },
    ingredients: [
      { quantity: "16", unit: "oz", name: "cottage cheese", preparation: null, rawText: "16 oz cottage cheese" },
      { quantity: "1/2", unit: "cup", name: "cocoa powder", preparation: null, rawText: "1/2 cup cocoa powder" },
      { quantity: "1/2", unit: "cup", name: "maple syrup", preparation: null, rawText: "1/2 cup maple syrup" },
      { quantity: "2", unit: null, name: "eggs", preparation: null, rawText: "2 eggs" },
      { quantity: "1/4", unit: "cup", name: "oat flour", preparation: null, rawText: "1/4 cup oat flour" },
      { quantity: "1", unit: "tsp", name: "baking powder", preparation: null, rawText: "1 tsp baking powder" },
      { quantity: "1/2", unit: "tsp", name: "salt", preparation: null, rawText: "1/2 tsp salt" },
      { quantity: "1/2", unit: "cup", name: "chocolate chips", preparation: null, rawText: "1/2 cup chocolate chips" },
    ],
    instructions: [
      "Preheat the oven to 350°F (175°C).",
      "Blend the cottage cheese, cocoa powder, maple syrup and eggs until completely smooth.",
      "Fold in the oat flour, baking powder and salt.",
      "Pour into a lined 8x8 pan and top with the chocolate chips.",
      "Bake for 35-40 minutes, until the centre is just set.",
      "Cool completely before slicing.",
    ],
  },
  expectedAssessment: { confidence: 1, warnings: [] },
  expectedFailure: null,
  notes:
    "The reference case for the whole project: every stated fact is captured, the " +
    "35-40 minute range survives as a range, and nothing is invented.",
};

const CHICKEN_TINGA: GoldenFixture = {
  id: "tiktok-chicken-tinga",
  summary: "Second complete TikTok recipe. Exact prep time and exact cook time, both stated.",
  quality: "ZERO_EDIT_EXPECTED",
  url: "https://www.tiktok.com/@tacotuesday/video/7322222222222222222",
  recordedSource: { kind: "tiktok-oembed", status: 200, file: "tiktok-chicken-tinga.oembed.json" },
  expectedSourceContent: {
    platform: "tiktok",
    url: "https://www.tiktok.com/@tacotuesday/video/7322222222222222222",
    creator: "tacotuesday",
    text:
      "CHICKEN TINGA \u{1F32E} the easiest weeknight taco filling\n\n" +
      "Prep time: 15 minutes\nCook time: 30 minutes\nServes 4\n\n" +
      "2 lb chicken thighs\n1 white onion, sliced\n3 cloves garlic, minced\n" +
      "14 oz fire roasted tomatoes\n2 chipotle peppers in adobo\n1 tbsp adobo sauce\n" +
      "1 tsp dried oregano\n1 tsp salt\n\n" +
      "Simmer the chicken in salted water until tender.\n" +
      "Blend the tomatoes, chipotles, adobo sauce and oregano until smooth.\n" +
      "Cook the onion and garlic in a little oil until soft.\n" +
      "Add the blended sauce and simmer until thickened.\n" +
      "Shred the chicken and toss it through the sauce.\n" +
      "Serve in warm tortillas.",
    textSource: "caption",
  },
  expectedExtraction: {
    title: "Chicken Tinga",
    description: null,
    servings: 4,
    prepTime: { minMinutes: 15, maxMinutes: null },
    cookTime: { minMinutes: 30, maxMinutes: null },
    ingredients: [
      { quantity: "2", unit: "lb", name: "chicken thighs", preparation: null, rawText: "2 lb chicken thighs" },
      { quantity: "1", unit: null, name: "white onion", preparation: "sliced", rawText: "1 white onion, sliced" },
      { quantity: "3", unit: "cloves", name: "garlic", preparation: "minced", rawText: "3 cloves garlic, minced" },
      { quantity: "14", unit: "oz", name: "fire roasted tomatoes", preparation: null, rawText: "14 oz fire roasted tomatoes" },
      { quantity: "2", unit: null, name: "chipotle peppers in adobo", preparation: null, rawText: "2 chipotle peppers in adobo" },
      { quantity: "1", unit: "tbsp", name: "adobo sauce", preparation: null, rawText: "1 tbsp adobo sauce" },
      { quantity: "1", unit: "tsp", name: "dried oregano", preparation: null, rawText: "1 tsp dried oregano" },
      { quantity: "1", unit: "tsp", name: "salt", preparation: null, rawText: "1 tsp salt" },
    ],
    instructions: [
      "Simmer the chicken in salted water until tender.",
      "Blend the tomatoes, chipotles, adobo sauce and oregano until smooth.",
      "Cook the onion and garlic in a little oil until soft.",
      "Add the blended sauce and simmer until thickened.",
      "Shred the chicken and toss it through the sauce.",
      "Serve in warm tortillas.",
    ],
  },
  expectedAssessment: { confidence: 1, warnings: [] },
  expectedFailure: null,
  notes:
    "Both times are exact, so both are encoded with maxMinutes null. An exact time " +
    "is never written as minMinutes === maxMinutes.",
};

const MISSING_SERVINGS: GoldenFixture = {
  id: "tiktok-missing-servings",
  summary: "Complete recipe, but the source never states a serving count.",
  quality: "ZERO_EDIT_EXPECTED",
  url: "https://www.tiktok.com/@skilletsuppers/video/7333333333333333333",
  recordedSource: { kind: "tiktok-oembed", status: 200, file: "tiktok-missing-servings.oembed.json" },
  expectedSourceContent: {
    platform: "tiktok",
    url: "https://www.tiktok.com/@skilletsuppers/video/7333333333333333333",
    creator: "skilletsuppers",
    text:
      "GARLIC BUTTER SHRIMP \u{1F364} my go-to weeknight dinner\n\n" +
      "1 lb shrimp, peeled\n4 tbsp butter\n4 cloves garlic, minced\n1 tsp red pepper flakes\n" +
      "1 lemon, juiced\n2 tbsp parsley, chopped\n\n" +
      "Melt the butter in a large skillet over medium heat.\n" +
      "Add the garlic and red pepper flakes and cook for 1 minute.\n" +
      "Add the shrimp and cook for 3 minutes per side.\n" +
      "Finish with the lemon juice and parsley.",
    textSource: "caption",
  },
  expectedExtraction: {
    title: "Garlic Butter Shrimp",
    description: null,
    servings: null,
    prepTime: null,
    cookTime: null,
    ingredients: [
      { quantity: "1", unit: "lb", name: "shrimp", preparation: "peeled", rawText: "1 lb shrimp, peeled" },
      { quantity: "4", unit: "tbsp", name: "butter", preparation: null, rawText: "4 tbsp butter" },
      { quantity: "4", unit: "cloves", name: "garlic", preparation: "minced", rawText: "4 cloves garlic, minced" },
      { quantity: "1", unit: "tsp", name: "red pepper flakes", preparation: null, rawText: "1 tsp red pepper flakes" },
      { quantity: "1", unit: null, name: "lemon", preparation: "juiced", rawText: "1 lemon, juiced" },
      { quantity: "2", unit: "tbsp", name: "parsley", preparation: "chopped", rawText: "2 tbsp parsley, chopped" },
    ],
    instructions: [
      "Melt the butter in a large skillet over medium heat.",
      "Add the garlic and red pepper flakes and cook for 1 minute.",
      "Add the shrimp and cook for 3 minutes per side.",
      "Finish with the lemon juice and parsley.",
    ],
  },
  expectedAssessment: {
    confidence: 0.9,
    warnings: [
      "No servings were stated in the source text.",
      "A duration appears in the recipe text but was not captured as a structured prep or cook time.",
    ],
  },
  expectedFailure: null,
  notes:
    "Two warnings, no errors. The step durations stay inside their instructions and are " +
    "never promoted to cookTime or summed into a total, which is why the second warning " +
    "fires rather than the plain 'no time stated' one. A missing serving count is faithful " +
    "to the source, so this is still zero-edit.",
};

const MISSING_QUANTITY: GoldenFixture = {
  id: "tiktok-missing-quantity",
  summary: "Two ingredients are listed with no quantity, exactly as the source wrote them.",
  quality: "ZERO_EDIT_EXPECTED",
  url: "https://www.tiktok.com/@butterandbake/video/7344444444444444444",
  recordedSource: { kind: "tiktok-oembed", status: 200, file: "tiktok-missing-quantity.oembed.json" },
  expectedSourceContent: {
    platform: "tiktok",
    url: "https://www.tiktok.com/@butterandbake/video/7344444444444444444",
    creator: "butterandbake",
    text:
      "BROWN BUTTER CHOCOLATE CHIP COOKIES \u{1F36A}\n\nMakes 24 cookies.\n\n" +
      "1 cup brown butter, cooled\n1 cup brown sugar\n2 eggs\n2 1/2 cups flour\n" +
      "1 tsp baking soda\nflaky sea salt\nvanilla extract\n\n" +
      "Cream the brown butter and brown sugar together.\n" +
      "Beat in the eggs and vanilla.\n" +
      "Fold in the flour and baking soda.\n" +
      "Chill the dough, then scoop onto a lined tray.\n" +
      "Bake at 350°F for 12 minutes.\n" +
      "Finish with flaky sea salt.",
    textSource: "caption",
  },
  expectedExtraction: {
    title: "Brown Butter Chocolate Chip Cookies",
    description: null,
    servings: 24,
    prepTime: null,
    cookTime: { minMinutes: 12, maxMinutes: null },
    ingredients: [
      { quantity: "1", unit: "cup", name: "brown butter", preparation: "cooled", rawText: "1 cup brown butter, cooled" },
      { quantity: "1", unit: "cup", name: "brown sugar", preparation: null, rawText: "1 cup brown sugar" },
      { quantity: "2", unit: null, name: "eggs", preparation: null, rawText: "2 eggs" },
      { quantity: "2 1/2", unit: "cups", name: "flour", preparation: null, rawText: "2 1/2 cups flour" },
      { quantity: "1", unit: "tsp", name: "baking soda", preparation: null, rawText: "1 tsp baking soda" },
      { quantity: null, unit: null, name: "flaky sea salt", preparation: null, rawText: "flaky sea salt" },
      { quantity: null, unit: null, name: "vanilla extract", preparation: null, rawText: "vanilla extract" },
    ],
    instructions: [
      "Cream the brown butter and brown sugar together.",
      "Beat in the eggs and vanilla.",
      "Fold in the flour and baking soda.",
      "Chill the dough, then scoop onto a lined tray.",
      "Bake at 350°F for 12 minutes.",
      "Finish with flaky sea salt.",
    ],
  },
  expectedAssessment: {
    confidence: 1,
    warnings: ["2 of 7 ingredients have no quantity in the source text."],
  },
  expectedFailure: null,
  notes:
    "Confidence 1 *with* a warning. Fewer than half the ingredients are unquantified, so " +
    "no penalty applies, but the warning is still reported. Anything that treats a " +
    "non-empty warnings array as a quality failure is wrong. The unquantified quantity " +
    "must stay null: '1 tsp' must never be invented for flaky sea salt.",
};

const EXACT_COOK_TIME: GoldenFixture = {
  id: "tiktok-exact-cook-time",
  summary: "A single stated bake time. Must encode as minMinutes with maxMinutes null.",
  quality: "ZERO_EDIT_EXPECTED",
  url: "https://www.tiktok.com/@slowdough/video/7355555555555555555",
  recordedSource: { kind: "tiktok-oembed", status: 200, file: "tiktok-exact-cook-time.oembed.json" },
  expectedSourceContent: {
    platform: "tiktok",
    url: "https://www.tiktok.com/@slowdough/video/7355555555555555555",
    creator: "slowdough",
    text:
      "NO-KNEAD FOCACCIA \u{1FAD2}\n\nServes 8\n\n" +
      "500 g bread flour\n400 g water\n10 g salt\n7 g instant yeast\n50 ml olive oil\n\n" +
      "Mix the flour, water, salt and yeast into a shaggy dough.\n" +
      "Rest the dough in the fridge overnight.\n" +
      "Stretch the dough into an oiled tray and dimple it with your fingers.\n" +
      "Bake at 220°C for 25 minutes.",
    textSource: "caption",
  },
  expectedExtraction: {
    title: "No-Knead Focaccia",
    description: null,
    servings: 8,
    prepTime: null,
    cookTime: { minMinutes: 25, maxMinutes: null },
    ingredients: [
      { quantity: "500", unit: "g", name: "bread flour", preparation: null, rawText: "500 g bread flour" },
      { quantity: "400", unit: "g", name: "water", preparation: null, rawText: "400 g water" },
      { quantity: "10", unit: "g", name: "salt", preparation: null, rawText: "10 g salt" },
      { quantity: "7", unit: "g", name: "instant yeast", preparation: null, rawText: "7 g instant yeast" },
      { quantity: "50", unit: "ml", name: "olive oil", preparation: null, rawText: "50 ml olive oil" },
    ],
    instructions: [
      "Mix the flour, water, salt and yeast into a shaggy dough.",
      "Rest the dough in the fridge overnight.",
      "Stretch the dough into an oiled tray and dimple it with your fingers.",
      "Bake at 220°C for 25 minutes.",
    ],
  },
  expectedAssessment: { confidence: 1, warnings: [] },
  expectedFailure: null,
  notes:
    "'overnight' is a duration the source states but does not quantify. It stays in the " +
    "instruction and is never turned into a number.",
};

const COOK_TIME_RANGE: GoldenFixture = {
  id: "tiktok-cook-time-range",
  summary: "A stated cook-time range. Both bounds must survive; the range is never averaged.",
  quality: "ZERO_EDIT_EXPECTED",
  url: "https://www.tiktok.com/@lowandslow/video/7366666666666666666",
  recordedSource: { kind: "tiktok-oembed", status: 200, file: "tiktok-cook-time-range.oembed.json" },
  expectedSourceContent: {
    platform: "tiktok",
    url: "https://www.tiktok.com/@lowandslow/video/7366666666666666666",
    creator: "lowandslow",
    text:
      "SLOW ROASTED TOMATO PASTA \u{1F345}\n\nServes 4\n\n" +
      "2 lb cherry tomatoes\n1/2 cup olive oil\n6 cloves garlic\n1 tsp chilli flakes\n" +
      "12 oz rigatoni\n1/2 cup basil\n\n" +
      "Toss the tomatoes, olive oil, garlic and chilli flakes in a baking dish.\n" +
      "Roast at 300°F for 90-120 minutes, until the tomatoes collapse.\n" +
      "Cook the rigatoni until al dente and reserve a cup of the pasta water.\n" +
      "Toss the pasta through the tomatoes, loosening with the pasta water.\n" +
      "Tear the basil over the top.",
    textSource: "caption",
  },
  expectedExtraction: {
    title: "Slow Roasted Tomato Pasta",
    description: null,
    servings: 4,
    prepTime: null,
    cookTime: { minMinutes: 90, maxMinutes: 120 },
    ingredients: [
      { quantity: "2", unit: "lb", name: "cherry tomatoes", preparation: null, rawText: "2 lb cherry tomatoes" },
      { quantity: "1/2", unit: "cup", name: "olive oil", preparation: null, rawText: "1/2 cup olive oil" },
      { quantity: "6", unit: "cloves", name: "garlic", preparation: null, rawText: "6 cloves garlic" },
      { quantity: "1", unit: "tsp", name: "chilli flakes", preparation: null, rawText: "1 tsp chilli flakes" },
      { quantity: "12", unit: "oz", name: "rigatoni", preparation: null, rawText: "12 oz rigatoni" },
      { quantity: "1/2", unit: "cup", name: "basil", preparation: null, rawText: "1/2 cup basil" },
    ],
    instructions: [
      "Toss the tomatoes, olive oil, garlic and chilli flakes in a baking dish.",
      "Roast at 300°F for 90-120 minutes, until the tomatoes collapse.",
      "Cook the rigatoni until al dente and reserve a cup of the pasta water.",
      "Toss the pasta through the tomatoes, loosening with the pasta water.",
      "Tear the basil over the top.",
    ],
  },
  expectedAssessment: { confidence: 1, warnings: [] },
  expectedFailure: null,
  notes:
    "The AnyList adapter flattens this to 90 and preserves '90–120 minutes' in the note. " +
    "That loss belongs to the adapter; the canonical Recipe keeps both bounds.",
};

const OPTIONAL_INGREDIENT: GoldenFixture = {
  id: "tiktok-optional-ingredient",
  summary: "An ingredient the source marks '(optional)'. The canonical model has no field for it.",
  quality: "ZERO_EDIT_EXPECTED",
  url: "https://www.tiktok.com/@sweetandsalty/video/7377777777777777777",
  recordedSource: { kind: "tiktok-oembed", status: 200, file: "tiktok-optional-ingredient.oembed.json" },
  expectedSourceContent: {
    platform: "tiktok",
    url: "https://www.tiktok.com/@sweetandsalty/video/7377777777777777777",
    creator: "sweetandsalty",
    text:
      "MISO CARAMEL POPCORN \u{1F37F}\n\nServes 6\n\n" +
      "1/2 cup popcorn kernels\n1 cup sugar\n1/2 cup butter\n2 tbsp white miso\n" +
      "1/2 tsp baking soda\n1/2 cup roasted peanuts (optional)\n\n" +
      "Pop the kernels and spread them on a lined tray.\n" +
      "Cook the sugar and butter until deep amber.\n" +
      "Whisk in the miso and baking soda.\n" +
      "Pour the caramel over the popcorn and toss.\n" +
      "Bake at 250°F for 45 minutes, stirring every 15 minutes.",
    textSource: "caption",
  },
  expectedExtraction: {
    title: "Miso Caramel Popcorn",
    description: null,
    servings: 6,
    prepTime: null,
    cookTime: { minMinutes: 45, maxMinutes: null },
    ingredients: [
      { quantity: "1/2", unit: "cup", name: "popcorn kernels", preparation: null, rawText: "1/2 cup popcorn kernels" },
      { quantity: "1", unit: "cup", name: "sugar", preparation: null, rawText: "1 cup sugar" },
      { quantity: "1/2", unit: "cup", name: "butter", preparation: null, rawText: "1/2 cup butter" },
      { quantity: "2", unit: "tbsp", name: "white miso", preparation: null, rawText: "2 tbsp white miso" },
      { quantity: "1/2", unit: "tsp", name: "baking soda", preparation: null, rawText: "1/2 tsp baking soda" },
      {
        quantity: "1/2",
        unit: "cup",
        name: "roasted peanuts",
        preparation: "optional",
        rawText: "1/2 cup roasted peanuts (optional)",
      },
    ],
    instructions: [
      "Pop the kernels and spread them on a lined tray.",
      "Cook the sugar and butter until deep amber.",
      "Whisk in the miso and baking soda.",
      "Pour the caramel over the popcorn and toss.",
      "Bake at 250°F for 45 minutes, stirring every 15 minutes.",
    ],
  },
  expectedAssessment: { confidence: 1, warnings: [] },
  expectedFailure: null,
  notes:
    "Optionality has no home in the canonical Ingredient. The only carriers are `preparation` " +
    "(which the adapter maps to the AnyList ingredient note) and `rawText` (which the adapter " +
    "drops). Putting it in `preparation` is the only route by which '(optional)' reaches " +
    "AnyList at all, and nothing in the schema enforces that. 'stirring every 15 minutes' " +
    "must not become a second cook time.",
};

const INCOMPLETE_CAPTION: GoldenFixture = {
  id: "instagram-incomplete-caption",
  summary: "Instagram Open Graph description, truncated mid-method by Instagram itself.",
  quality: "EDIT_EXPECTED",
  url: "https://www.instagram.com/reel/Cq1incomplete/",
  recordedSource: { kind: "instagram-html", status: 200, file: "instagram-incomplete-caption.html" },
  expectedSourceContent: {
    platform: "instagram",
    url: "https://www.instagram.com/reel/Cq1incomplete/",
    creator: "pastachef",
    text:
      "CACIO E PEPE the way my nonna taught me \u{1F9C0} 300 g spaghetti, 150 g pecorino romano, " +
      "2 tsp black pepper. Toast the pepper in a dry pan, then…",
    textSource: "og-description",
  },
  expectedExtraction: {
    title: "Cacio e Pepe",
    description: null,
    servings: null,
    prepTime: null,
    cookTime: null,
    ingredients: [
      { quantity: "300", unit: "g", name: "spaghetti", preparation: null, rawText: "300 g spaghetti" },
      { quantity: "150", unit: "g", name: "pecorino romano", preparation: null, rawText: "150 g pecorino romano" },
      { quantity: "2", unit: "tsp", name: "black pepper", preparation: null, rawText: "2 tsp black pepper" },
    ],
    instructions: ["Toast the pepper in a dry pan."],
  },
  expectedAssessment: {
    confidence: 0.8,
    warnings: [
      "No servings were stated in the source text.",
      "No prep or cook time was stated in the source text.",
      "Recipe was extracted from Open Graph metadata, which is often a truncated version of the caption.",
    ],
  },
  expectedFailure: null,
  notes:
    "The ingredients are complete but the method stops mid-sentence, so the user has to " +
    "write the rest. This is the case the Open Graph warning exists for.",
};

const INGREDIENT_ONLY_IN_INSTRUCTIONS: GoldenFixture = {
  id: "tiktok-ingredient-only-in-instructions",
  summary:
    "Sage, salt, pepper and parmesan are used in the method but never listed as ingredients.",
  quality: "EDIT_EXPECTED",
  url: "https://www.tiktok.com/@panfriedpasta/video/7388888888888888888",
  recordedSource: {
    kind: "tiktok-oembed",
    status: 200,
    file: "tiktok-ingredient-only-in-instructions.oembed.json",
  },
  expectedSourceContent: {
    platform: "tiktok",
    url: "https://www.tiktok.com/@panfriedpasta/video/7388888888888888888",
    creator: "panfriedpasta",
    text:
      "CRISPY GNOCCHI WITH SAGE BROWN BUTTER \u{1F33F}\n\nServes 2\n\n" +
      "1 lb shelf-stable gnocchi\n4 tbsp butter\n\n" +
      "Fry the gnocchi in a hot pan until crisp and golden.\n" +
      "Add the butter and let it foam and brown.\n" +
      "Drop in the sage leaves and fry until crisp.\n" +
      "Season with salt and pepper and finish with the parmesan.",
    textSource: "caption",
  },
  expectedExtraction: {
    title: "Crispy Gnocchi with Sage Brown Butter",
    description: null,
    servings: 2,
    prepTime: null,
    cookTime: null,
    ingredients: [
      {
        quantity: "1",
        unit: "lb",
        name: "shelf-stable gnocchi",
        preparation: null,
        rawText: "1 lb shelf-stable gnocchi",
      },
      { quantity: "4", unit: "tbsp", name: "butter", preparation: null, rawText: "4 tbsp butter" },
    ],
    instructions: [
      "Fry the gnocchi in a hot pan until crisp and golden.",
      "Add the butter and let it foam and brown.",
      "Drop in the sage leaves and fry until crisp.",
      "Season with salt and pepper and finish with the parmesan.",
    ],
  },
  expectedAssessment: {
    confidence: 0.95,
    warnings: ["No prep or cook time was stated in the source text."],
  },
  expectedFailure: null,
  notes:
    "The most important fixture in the corpus. The extraction is entirely faithful — inventing " +
    "'1 bunch sage' would be a worse bug — yet the recipe is unusable as a shopping list, " +
    "so the user must edit it. Confidence is 0.95 and the only warning is about a missing " +
    "time. Neither signal detects the actual problem. Any confidence gate built on these " +
    "values (ADR-009) will not catch this class of gap.",
};

const UNSUPPORTED_URL: GoldenFixture = {
  id: "unsupported-url-pinterest",
  summary: "A valid URL on a host we do not ingest.",
  quality: "FAIL_EXPECTED",
  url: "https://www.pinterest.com/pin/1234567890/",
  recordedSource: { kind: "never-fetched", reason: "Rejected at platform detection, before any request." },
  expectedSourceContent: null,
  expectedExtraction: null,
  expectedAssessment: null,
  expectedFailure: {
    extractionCode: "unsupported_platform",
    importKind: "unsupported_platform",
    httpStatus: 400,
    httpError: "Unsupported platform",
  },
  notes: "Detection happens on the parsed hostname, so no network request is made at all.",
};

const INSTAGRAM_LOGIN_WALL: GoldenFixture = {
  id: "instagram-login-wall",
  summary: "Instagram served a login page with no usable og:description. The designed failure.",
  quality: "FAIL_EXPECTED",
  url: "https://www.instagram.com/reel/CqLoginWall/",
  recordedSource: { kind: "instagram-html", status: 200, file: "instagram-login-wall.html" },
  expectedSourceContent: null,
  expectedExtraction: null,
  expectedAssessment: null,
  expectedFailure: {
    extractionCode: "source_unavailable",
    importKind: "extraction_failed",
    httpStatus: 422,
    httpError: "Recipe could not be extracted",
  },
  notes:
    "HTTP 200 with a login page. The failure is detected by the absence of a usable caption, " +
    "not by the status code. No Anthropic call is made, so a blocked Instagram post costs nothing.",
};

const INSTAGRAM_LOGIN_BLURB: GoldenFixture = {
  id: "instagram-login-blurb",
  summary:
    "Instagram served a login page that DOES carry a generic og:description. Ingestion does not reject it.",
  quality: "FAIL_EXPECTED",
  url: "https://www.instagram.com/reel/CqLoginBlurb/",
  recordedSource: { kind: "instagram-html", status: 200, file: "instagram-login-blurb.html" },
  expectedSourceContent: {
    platform: "instagram",
    url: "https://www.instagram.com/reel/CqLoginBlurb/",
    creator: null,
    text:
      "Welcome back to Instagram. Sign in to check out what your friends, family & interests " +
      "have been capturing & sharing around the world.",
    textSource: "og-description",
  },
  expectedExtraction: {
    title: "Instagram Login Page",
    description: null,
    servings: null,
    prepTime: null,
    cookTime: null,
    ingredients: [],
    instructions: [],
  },
  expectedAssessment: {
    confidence: 0.1,
    warnings: [
      "No ingredients were found in the source text.",
      "No instructions were found in the source text.",
      "No servings were stated in the source text.",
      "No prep or cook time was stated in the source text.",
      "Recipe was extracted from Open Graph metadata, which is often a truncated version of the caption.",
      "The source creator could not be determined.",
    ],
  },
  expectedFailure: null,
  notes:
    "Classified FAIL_EXPECTED because the user must not get a recipe — but the pipeline does " +
    "not fail. The adapter accepts the login blurb as a caption, the model is called and paid " +
    "for, and the result is an empty recipe at confidence 0.1 that the API returns as 200 and " +
    "writes to AnyList. Nothing anywhere applies a confidence floor. This is the gap between " +
    "'fails cleanly behind a login wall' as documented and what happens when the login page " +
    "carries a description. See docs/qa/findings.md QA-002 and QA-003.",
};

const YOUTUBE_NOT_INGESTIBLE: GoldenFixture = {
  id: "youtube-canonical-not-ingestible",
  summary: "YouTube is a canonical platform value, but no ingestion adapter exists.",
  quality: "FAIL_EXPECTED",
  url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  recordedSource: { kind: "never-fetched", reason: "youtube.com is not a recognised ingestion host." },
  expectedSourceContent: null,
  expectedExtraction: null,
  expectedAssessment: null,
  expectedFailure: {
    extractionCode: "unsupported_platform",
    importKind: "unsupported_platform",
    httpStatus: 400,
    httpError: "Unsupported platform",
  },
  notes:
    "Canonical support and ingestion are different things (ADR-015). RecipeSchema accepts " +
    'source.platform "youtube"; detectPlatform rejects a youtube.com URL. Both halves are ' +
    "asserted. Whether this deserves a distinct status code instead of 400 is an open, " +
    "unproposed contract question.",
};

export const GOLDEN_CORPUS: readonly GoldenFixture[] = [
  COTTAGE_CHEESE_BROWNIES,
  CHICKEN_TINGA,
  MISSING_SERVINGS,
  MISSING_QUANTITY,
  EXACT_COOK_TIME,
  COOK_TIME_RANGE,
  OPTIONAL_INGREDIENT,
  INCOMPLETE_CAPTION,
  INGREDIENT_ONLY_IN_INSTRUCTIONS,
  UNSUPPORTED_URL,
  INSTAGRAM_LOGIN_WALL,
  INSTAGRAM_LOGIN_BLURB,
  YOUTUBE_NOT_INGESTIBLE,
];

export function fixture(id: string): GoldenFixture {
  const found = GOLDEN_CORPUS.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`No golden fixture with id "${id}".`);
  return found;
}

/** Fixtures whose ingestion is expected to succeed, i.e. those with a recorded body to serve. */
export const INGESTIBLE_FIXTURES = GOLDEN_CORPUS.filter(
  (entry) => entry.expectedSourceContent !== null,
);

/** Fixtures that must produce a canonical Recipe. */
export const EXTRACTING_FIXTURES = GOLDEN_CORPUS.filter((entry) => entry.expectedExtraction !== null);

/** Fixtures that must be rejected somewhere in the pipeline. */
export const FAILING_FIXTURES = GOLDEN_CORPUS.filter((entry) => entry.expectedFailure !== null);
