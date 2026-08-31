import { describe, expect, it } from "vitest";

import { EXTRACTING_FIXTURES, FAILING_FIXTURES, GOLDEN_CORPUS } from "../../fixtures/corpus.js";
import type { QualityExpectation } from "../../fixtures/types.js";
import { expectedRecipe } from "../../fixtures/types.js";

/**
 * Integrity of the corpus itself, plus the extraction-quality benchmark.
 *
 * The benchmark is the North Star metric ("would the user need to edit this
 * before saving?") reduced to something a test can hold: a fixed corpus with a
 * fixed classification per fixture. It is not analytics. Its whole job is to
 * make a change in extraction quality show up as a diff.
 */

function countByQuality(): Record<QualityExpectation, number> {
  const counts: Record<QualityExpectation, number> = {
    ZERO_EDIT_EXPECTED: 0,
    EDIT_EXPECTED: 0,
    FAIL_EXPECTED: 0,
  };
  for (const entry of GOLDEN_CORPUS) counts[entry.quality] += 1;
  return counts;
}

describe("corpus integrity", () => {
  it("has a unique id for every fixture", () => {
    const ids = GOLDEN_CORPUS.map((entry) => entry.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers every scenario the QA brief requires", () => {
    const ids = new Set(GOLDEN_CORPUS.map((entry) => entry.id));

    for (const required of [
      "tiktok-cottage-cheese-brownies",
      "tiktok-chicken-tinga",
      "tiktok-missing-servings",
      "tiktok-missing-quantity",
      "tiktok-exact-cook-time",
      "tiktok-cook-time-range",
      "tiktok-optional-ingredient",
      "instagram-incomplete-caption",
      "tiktok-ingredient-only-in-instructions",
      "unsupported-url-pinterest",
      "instagram-login-wall",
      "youtube-canonical-not-ingestible",
    ]) {
      expect(ids).toContain(required);
    }
  });

  it("gives every fixture either an expected recipe or an expected failure", () => {
    for (const entry of GOLDEN_CORPUS) {
      const hasRecipe = entry.expectedExtraction !== null;
      const hasFailure = entry.expectedFailure !== null;

      expect(hasRecipe || hasFailure).toBe(true);
      expect(hasRecipe && hasFailure).toBe(false);
    }
  });

  it("pairs an expected extraction with both a source content and an assessment", () => {
    for (const entry of EXTRACTING_FIXTURES) {
      expect(entry.expectedSourceContent).not.toBeNull();
      expect(entry.expectedAssessment).not.toBeNull();
      expect(expectedRecipe(entry)).not.toBeNull();
    }
  });

  it("gives every failing fixture a full classification", () => {
    for (const entry of FAILING_FIXTURES) {
      const failure = entry.expectedFailure;

      expect(failure?.importKind).toBeTruthy();
      expect(failure?.httpStatus).toBeGreaterThanOrEqual(400);
      expect(failure?.httpError).toBeTruthy();
    }
  });

  it("uses only canonical platform values for source content", () => {
    for (const entry of GOLDEN_CORPUS) {
      if (entry.expectedSourceContent === null) continue;
      expect(["tiktok", "instagram"]).toContain(entry.expectedSourceContent.platform);
    }
  });

  it("covers both ingestible platforms and the canonical-only one", () => {
    const platforms = new Set(
      GOLDEN_CORPUS.map((entry) => entry.expectedSourceContent?.platform).filter(Boolean),
    );

    expect(platforms).toEqual(new Set(["tiktok", "instagram"]));
    expect(GOLDEN_CORPUS.some((entry) => entry.id === "youtube-canonical-not-ingestible")).toBe(true);
  });

  it("explains every fixture that is not self-evident", () => {
    for (const entry of GOLDEN_CORPUS) {
      expect(entry.summary.length).toBeGreaterThan(0);
    }
  });
});

describe("extraction-quality benchmark", () => {
  /**
   * The recorded baseline. Changing these numbers is a deliberate act: it means
   * either the corpus grew or extraction quality moved. Both deserve a diff.
   */
  const BASELINE = { ZERO_EDIT_EXPECTED: 9, EDIT_EXPECTED: 2, FAIL_EXPECTED: 4 } as const;

  it("matches the recorded classification baseline", () => {
    expect(countByQuality()).toEqual(BASELINE);
  });

  it("holds the zero-edit rate over deliverable fixtures at the recorded baseline", () => {
    // "Deliverable" means the pipeline is expected to hand the user a recipe at
    // all, so the FAIL_EXPECTED fixtures are excluded rather than counted as
    // quality failures. 9 of 11.
    const deliverable = GOLDEN_CORPUS.filter((entry) => entry.quality !== "FAIL_EXPECTED");
    const zeroEdit = deliverable.filter((entry) => entry.quality === "ZERO_EDIT_EXPECTED");

    expect(deliverable).toHaveLength(11);
    expect(zeroEdit).toHaveLength(9);
    expect(Math.round((zeroEdit.length / deliverable.length) * 100)).toBe(82);
  });

  it("keeps a warning from being read as an edit requirement", () => {
    // Four zero-edit fixtures carry warnings. A warning describes what the
    // source lacked, not what extraction got wrong (ADR-010) — and in
    // instagram-sweet-potato-tart's case, one of them describes a risk the
    // source did not actually run (QA-029), which is still not an edit.
    const zeroEditWithWarnings = GOLDEN_CORPUS.filter(
      (entry) =>
        entry.quality === "ZERO_EDIT_EXPECTED" && (entry.expectedAssessment?.warnings.length ?? 0) > 0,
    );

    expect(zeroEditWithWarnings.map((entry) => entry.id)).toEqual([
      "tiktok-missing-servings",
      "tiktok-missing-quantity",
      "instagram-sweet-potato-tart",
      "tiktok-us-primary-no-alternates",
    ]);
  });

  it("does not let confidence stand in for the quality classification", () => {
    // An EDIT_EXPECTED fixture scores higher than a ZERO_EDIT_EXPECTED one.
    // Confidence measures what the source stated; the classification measures
    // whether the user has work to do. They are not the same axis.
    const needsEdit = GOLDEN_CORPUS.find((e) => e.id === "tiktok-ingredient-only-in-instructions");
    const clean = GOLDEN_CORPUS.find((e) => e.id === "tiktok-missing-servings");

    expect(needsEdit?.expectedAssessment?.confidence).toBeGreaterThan(
      clean?.expectedAssessment?.confidence ?? 1,
    );
  });
});
