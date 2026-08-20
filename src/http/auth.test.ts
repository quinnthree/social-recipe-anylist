import { describe, expect, it } from "vitest";

import { isAuthorized } from "./auth.js";

const SECRET = "s3cret-api-key";

describe("isAuthorized", () => {
  it("accepts the exact bearer token", () => {
    expect(isAuthorized(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it.each([
    ["undefined header", undefined],
    ["empty header", ""],
    ["no scheme", SECRET],
    ["wrong scheme", `Basic ${SECRET}`],
    ["lowercase scheme", `bearer ${SECRET}`],
    ["empty token", "Bearer "],
    ["wrong token", "Bearer nope"],
    ["trailing character", `Bearer ${SECRET}x`],
    ["leading space", `Bearer  ${SECRET}`],
  ])("rejects %s", (_label, header) => {
    expect(isAuthorized(header, SECRET)).toBe(false);
  });

  it("rejects a token of a different length without throwing", () => {
    // timingSafeEqual throws on length mismatch; hashing first prevents that.
    expect(() => isAuthorized("Bearer x", SECRET)).not.toThrow();
    expect(isAuthorized("Bearer x", SECRET)).toBe(false);
    expect(isAuthorized(`Bearer ${"y".repeat(500)}`, SECRET)).toBe(false);
  });
});
