import { describe, expect, it } from "vitest";

import { parseQuantity } from "./quantity.js";

const exact = (value: number) => ({ kind: "exact", value });

describe("the quantity grammar", () => {
  it.each([
    ["400", 400],
    ["2", 2],
    ["1000", 1000],
  ])("reads the integer %s", (text, value) => {
    expect(parseQuantity(text)).toEqual(exact(value));
  });

  it.each([
    ["3.5", 3.5],
    ["1.25", 1.25],
    ["0.5", 0.5],
  ])("reads the decimal %s", (text, value) => {
    expect(parseQuantity(text)).toEqual(exact(value));
  });

  it.each([
    ["1/2", 0.5],
    ["3/4", 0.75],
    ["1/3", 1 / 3],
    ["2/3", 2 / 3],
    ["1/8", 0.125],
  ])("reads the ASCII fraction %s", (text, value) => {
    expect(parseQuantity(text)).toEqual(exact(value));
  });

  it.each([
    ["1 1/2", 1.5],
    ["2 3/4", 2.75],
    ["10 1/3", 10 + 1 / 3],
  ])("reads the mixed number %s", (text, value) => {
    expect(parseQuantity(text)).toEqual(exact(value));
  });

  it.each([
    ["½", 0.5],
    ["¾", 0.75],
    ["⅓", 1 / 3],
    ["⅔", 2 / 3],
    ["¼", 0.25],
    ["⅛", 0.125],
  ])("reads the Unicode fraction %s", (text, value) => {
    expect(parseQuantity(text)).toEqual(exact(value));
  });

  it.each([
    ["1½", 1.5],
    ["2¾", 2.75],
    ["1 ½", 1.5],
  ])("reads the Unicode mixed form %s", (text, value) => {
    expect(parseQuantity(text)).toEqual(exact(value));
  });

  it.each([
    ["2-3", 2, 3],
    ["2–3", 2, 3],
    ["2—3", 2, 3],
    ["2 to 3", 2, 3],
    ["2 - 3", 2, 3],
    ["1 1/2-2", 1.5, 2],
    ["2 to 2.5", 2, 2.5],
    ["½-¾", 0.5, 0.75],
  ])("reads the range %s", (text, min, max) => {
    expect(parseQuantity(text)).toEqual({ kind: "range", min, max });
  });

  it("ignores surrounding whitespace", () => {
    expect(parseQuantity("  1 1/2  ")).toEqual(exact(1.5));
  });
});

describe("the parser fails closed", () => {
  it.each([
    "to taste",
    "a handful",
    "about two",
    "two",
    "some",
    "a few",
    "as needed",
    "1 ½ cups",
    "400g",
  ])("refuses the prose %j", (text) => {
    expect(parseQuantity(text)).toBeNull();
  });

  it.each(["1/0", "1/", "/2", "//", "3/0"])("refuses the malformed fraction %j", (text) => {
    // A zero denominator would otherwise produce Infinity and convert into a
    // number nobody can measure.
    expect(parseQuantity(text)).toBeNull();
  });

  it.each(["0", "0.0", "0/5", "-3", "-1.5"])("refuses the non-positive amount %j", (text) => {
    // "-3" is the interesting one: a leading hyphen looks like a range
    // separator, and dropping the empty left-hand side would turn a negative
    // quantity into a positive one.
    expect(parseQuantity(text)).toBeNull();
  });

  it.each(["3-2", "2-2", "5 to 1"])("refuses the inverted or empty range %j", (text) => {
    // A range whose end is not above its start is not a range anyone stated.
    expect(parseQuantity(text)).toBeNull();
  });

  it.each(["1-2-3", "1 1/2 1/2", "1,5", "1.2.3", "٤"])("refuses the malformed %j", (text) => {
    expect(parseQuantity(text)).toBeNull();
  });

  it("refuses an empty, blank, or absent quantity", () => {
    expect(parseQuantity("")).toBeNull();
    expect(parseQuantity("   ")).toBeNull();
    expect(parseQuantity(null)).toBeNull();
  });

  it("refuses a bare decimal point form", () => {
    // ".5" is rejected: a leading digit is required, so nothing has to guess
    // whether a stray dot was a typo.
    expect(parseQuantity(".5")).toBeNull();
  });
});

describe("the parser never rewrites the source", () => {
  it("returns a reading, leaving the caller's string untouched", () => {
    const source = "1 1/2";
    parseQuantity(source);

    expect(source).toBe("1 1/2");
  });

  it("produces the same number for every spelling of the same amount", () => {
    // The canonical string keeps whichever spelling the creator used; only the
    // engine's private reading is normalised.
    const forms = ["1.5", "1 1/2", "1½", "1 ½", "3/2"];

    for (const form of forms) {
      expect(parseQuantity(form)).toEqual(exact(1.5));
    }
  });
});
