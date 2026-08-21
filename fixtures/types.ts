import { readFileSync } from "node:fs";

import type { ExtractedRecipe, Recipe } from "../src/recipe/schema.js";
import type { ExtractionErrorCode, SourceContent } from "../src/social/types.js";
import type { ImportFailureKind } from "../src/app/import-service.js";

/**
 * How much correction the user would have to do before this recipe is worth
 * saving. This is the project's North Star metric expressed per fixture:
 * "percentage of extracted recipes that can be saved to AnyList without
 * requiring user correction."
 *
 * The rule, applied consistently across the corpus:
 *
 * - ZERO_EDIT_EXPECTED — every fact the source states is captured correctly and
 *   nothing in the recipe is wrong. A field that is null because the source
 *   never stated it is *faithful*, not an edit. Warnings do not downgrade a
 *   fixture: a warning reports what the source lacked, not what we got wrong.
 * - EDIT_EXPECTED — the extraction is faithful to the text, but the recipe is
 *   not usable as written without the user supplying or correcting something.
 * - FAIL_EXPECTED — no recipe should be produced at all. The pipeline must fail
 *   cleanly with the stated classification.
 */
export type QualityExpectation = "ZERO_EDIT_EXPECTED" | "EDIT_EXPECTED" | "FAIL_EXPECTED";

/**
 * The recorded upstream response for this fixture. Tests serve these through a
 * stubbed `fetch`; nothing in the automated suite talks to TikTok or Instagram.
 */
export type RecordedSource =
  | { kind: "tiktok-oembed"; status: number; file: string }
  | { kind: "instagram-html"; status: number; file: string }
  /** The URL is rejected before any request is made. */
  | { kind: "never-fetched"; reason: string };

export interface ExpectedFailure {
  /** null when the failure is not an ExtractionError (e.g. a model failure). */
  extractionCode: ExtractionErrorCode | null;
  importKind: ImportFailureKind;
  /** As returned by the current POST /api/import. */
  httpStatus: number;
  httpError: string;
}

export interface ExpectedAssessment {
  confidence: number;
  warnings: string[];
}

export interface GoldenFixture {
  id: string;
  summary: string;
  quality: QualityExpectation;
  /** The original social URL, preserved verbatim through the whole pipeline. */
  url: string;
  recordedSource: RecordedSource;

  /**
   * What the ingestion adapter must produce from `recordedSource`. Fully
   * deterministic and asserted automatically. null when ingestion must fail.
   */
  expectedSourceContent: SourceContent | null;

  /**
   * THE MODEL BOUNDARY. This is the golden expectation for the fields Claude
   * must produce from `expectedSourceContent.text` — it is an expectation, not
   * a recording, and no automated test can verify it, because the extraction
   * call is non-deterministic and live calls are forbidden in the suite.
   *
   * Automated tests use it as the deterministic *input* to everything
   * downstream: assessment, canonical validation, and the AnyList mapping.
   * Verifying that the model actually produces it is a LIVE EXTERNAL gate item
   * (see docs/qa/release-gate.md).
   */
  expectedExtraction: ExtractedRecipe | null;

  /**
   * Deterministic output of `assessExtraction(expectedExtraction, expectedSourceContent)`.
   * Asserted automatically.
   */
  expectedAssessment: ExpectedAssessment | null;

  /** Set when the pipeline must reject rather than produce a recipe. */
  expectedFailure: ExpectedFailure | null;

  /** Anything a reader needs to know that the fields above do not say. */
  notes: string | null;
}

/**
 * Composes the expected canonical Recipe from the parts recorded above, exactly
 * as `parseRecipe` does: model fields, plus source and assessment attached from
 * data we control. Composing rather than restating means the corpus cannot
 * drift against itself.
 */
export function expectedRecipe(fixture: GoldenFixture): Recipe | null {
  const { expectedExtraction, expectedSourceContent, expectedAssessment } = fixture;
  if (expectedExtraction === null || expectedSourceContent === null || expectedAssessment === null) {
    return null;
  }

  return {
    ...expectedExtraction,
    source: {
      platform: expectedSourceContent.platform,
      creator: expectedSourceContent.creator,
      url: expectedSourceContent.url,
    },
    confidence: expectedAssessment.confidence,
    warnings: expectedAssessment.warnings,
  };
}

/**
 * Same as `expectedRecipe`, for the common case where a caller has already
 * chosen a fixture that must have one. Returns a non-nullable Recipe so callers
 * do not each repeat a null guard that closures then lose track of.
 */
export function requireRecipe(fixture: GoldenFixture): Recipe {
  const recipe = expectedRecipe(fixture);
  if (recipe === null) {
    throw new Error(`Fixture "${fixture.id}" has no expected recipe, but one was required.`);
  }
  return recipe;
}

/** Reads a recorded upstream response body from fixtures/sources. */
export function readRecordedBody(file: string): string {
  return readFileSync(new URL(`./sources/${file}`, import.meta.url), "utf8");
}
