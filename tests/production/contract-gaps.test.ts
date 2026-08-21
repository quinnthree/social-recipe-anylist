import { describe, expect, it } from "vitest";

import {
  gap,
  OPEN_QUESTIONS,
  RESOLVED_QUESTIONS,
  UNRESOLVED_CONTRACT_QUESTIONS,
} from "./contract-gaps.js";

/**
 * Keeps the contract-gap register honest.
 *
 * The register is a QA artifact, not a contract, but it drives which
 * assertions the endpoint specifications are allowed to make. A gap silently
 * disappearing, or a resolved one losing its resolution, would let a spec
 * assert something the contract never actually decided.
 */

describe("the contract-gap register", () => {
  it("has a unique id for every entry", () => {
    const ids = UNRESOLVED_CONTRACT_QUESTIONS.map((entry) => entry.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("records what every entry blocks", () => {
    for (const entry of UNRESOLVED_CONTRACT_QUESTIONS) {
      expect(entry.question.length).toBeGreaterThan(0);
      expect(entry.blocks.length).toBeGreaterThan(0);
    }
  });

  it("gives every resolved entry a resolution, and every open one none", () => {
    for (const entry of RESOLVED_QUESTIONS) {
      expect(entry.resolution).toBeTruthy();
    }
    for (const entry of OPEN_QUESTIONS) {
      expect(entry.resolution).toBeNull();
    }
  });

  it("holds the recorded counts after the production contract landed", () => {
    // Six of the eight original questions were answered. Changing these numbers
    // is a deliberate act: it means the contract moved.
    expect(RESOLVED_QUESTIONS).toHaveLength(6);
    expect(OPEN_QUESTIONS).toHaveLength(5);
  });

  it("resolved every question that blocked the iOS client except one", () => {
    const blockingIos = OPEN_QUESTIONS.filter((entry) => entry.severity === "blocks-ios-client");

    expect(blockingIos.map((entry) => entry.id)).toEqual(["QA-013"]);
  });

  it.each(["QA-011", "QA-012", "QA-014", "QA-015", "QA-016", "QA-017"])(
    "%s is resolved by the approved contract",
    (id) => {
      expect(gap(id).resolved).toBe(true);
    },
  );

  it.each(["QA-013", "QA-018", "QA-021", "QA-022", "QA-023"])("%s is still open", (id) => {
    expect(gap(id).resolved).toBe(false);
  });
});
