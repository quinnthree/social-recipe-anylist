import { describe, expect, it } from "vitest";

import { EXTRACTING_FIXTURES, fixture } from "../../fixtures/corpus.js";
import { assessExtraction } from "../../src/recipe/parser.js";

/**
 * confidence and warnings are computed deterministically in our code, never by
 * the model (ADR-009). That makes them exactly assertable for the whole corpus,
 * and they are the intended gate for expensive multimodal extraction, so they
 * need to stay pinned.
 */

describe("assessExtraction matches the golden assessment", () => {
  it.each(EXTRACTING_FIXTURES.map((f) => [f.id, f] as const))("%s", (_id, entry) => {
    const { expectedExtraction, expectedSourceContent, expectedAssessment } = entry;
    if (expectedExtraction === null || expectedSourceContent === null) {
      throw new Error(`${entry.id} is in EXTRACTING_FIXTURES but has no extraction.`);
    }

    expect(assessExtraction(expectedExtraction, expectedSourceContent)).toEqual(expectedAssessment);
  });
});

describe("what the assessment does and does not signal", () => {
  it("reports a warning at full confidence when fewer than half the ingredients are unquantified", () => {
    // Confidence 1 and a non-empty warnings array are not contradictory. An
    // export path that treats warnings as a rejection reason would break this
    // recipe for no reason (ADR-010).
    const entry = fixture("tiktok-missing-quantity");

    expect(entry.expectedAssessment?.confidence).toBe(1);
    expect(entry.expectedAssessment?.warnings).toHaveLength(1);
  });

  it("does not detect ingredients that appear only in the instructions", () => {
    // The single most consequential extraction gap in the corpus scores 0.95
    // with one unrelated warning. Recorded so that a future confidence gate is
    // designed knowing this class of failure is invisible to it.
    const entry = fixture("tiktok-ingredient-only-in-instructions");

    expect(entry.quality).toBe("EDIT_EXPECTED");
    expect(entry.expectedAssessment?.confidence).toBe(0.95);
    expect(entry.expectedAssessment?.warnings).toEqual([
      "No prep or cook time was stated in the source text.",
    ]);
  });

  it("never sees a login-page blurb, because ingestion now rejects it", () => {
    // QA-002 RESOLVED. This fixture used to reach assessment and score 0.1,
    // which was the only signal that anything was wrong. The hardened Instagram
    // adapter rejects the interstitial before any model call, so there is no
    // extraction to assess and confidence is not load-bearing here any more.
    const blurb = fixture("instagram-login-blurb");

    expect(blurb.expectedExtraction).toBeNull();
    expect(blurb.expectedAssessment).toBeNull();
    expect(blurb.expectedFailure?.importKind).toBe("extraction_failed");
  });

  it("keeps every corpus confidence inside 0..1", () => {
    for (const entry of EXTRACTING_FIXTURES) {
      const confidence = entry.expectedAssessment?.confidence ?? -1;

      expect(confidence).toBeGreaterThanOrEqual(0);
      expect(confidence).toBeLessThanOrEqual(1);
    }
  });

  it("never reports both time warnings at once", () => {
    const absent = "No prep or cook time was stated in the source text.";
    const uncaptured =
      "A duration appears in the recipe text but was not captured as a structured prep or cook time.";

    for (const entry of EXTRACTING_FIXTURES) {
      const warnings = entry.expectedAssessment?.warnings ?? [];
      expect(warnings.includes(absent) && warnings.includes(uncaptured)).toBe(false);
    }
  });
});
