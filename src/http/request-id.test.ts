import { describe, expect, it } from "vitest";

import { generateRequestId, resolveRequestId } from "./request-id.js";

/** `req_` plus 26 Crockford base32 characters — no I, L, O, or U. */
const SHAPE = /^req_[0-9A-HJKMNP-TV-Z]{26}$/;

describe("generateRequestId", () => {
  it("produces the documented shape", () => {
    expect(generateRequestId()).toMatch(SHAPE);
  });

  it("does not repeat", () => {
    const ids = new Set(Array.from({ length: 500 }, () => generateRequestId()));

    expect(ids.size).toBe(500);
  });

  it("sorts chronologically, so a log dump is ordered without a timestamp field", () => {
    const earlier = generateRequestId(1_700_000_000_000);
    const later = generateRequestId(1_700_000_001_000);

    expect(earlier < later).toBe(true);
  });
});

describe("resolveRequestId", () => {
  it("generates one when the client sends nothing", () => {
    const { requestId, source } = resolveRequestId(undefined);

    expect(requestId).toMatch(SHAPE);
    expect(source).toBe("generated");
  });

  it("adopts a safe client value so the client can correlate its own traces", () => {
    expect(resolveRequestId("shortcut-run-42")).toEqual({
      requestId: "shortcut-run-42",
      source: "client",
    });
  });

  it("takes the first value when the header is repeated", () => {
    expect(resolveRequestId(["first-value-1", "second-value"]).requestId).toBe("first-value-1");
  });

  it.each([
    ["too short", "abc"],
    ["too long", "x".repeat(65)],
    ["path traversal", "../../etc/passwd"],
    ["header injection", "abcdefgh\r\nX-Evil: 1"],
    ["whitespace", "abc defgh"],
    ["empty", ""],
    ["not a string", 42],
  ])("regenerates rather than rejecting: %s", (_label, header) => {
    const { requestId, source } = resolveRequestId(header);

    // A malformed trace header must never fail an otherwise valid import.
    expect(requestId).toMatch(SHAPE);
    expect(source).toBe("generated");
  });
});
