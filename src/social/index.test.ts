import { describe, expect, it } from "vitest";

import { detectPlatform } from "./index.js";
import { ExtractionError } from "./types.js";

describe("detectPlatform", () => {
  it.each([
    "https://www.instagram.com/reel/Cxyz123/",
    "https://instagram.com/p/Cxyz123/",
    "https://www.instagram.com/reels/Cxyz123/?igsh=abc",
  ])("identifies Instagram: %s", (url) => {
    expect(detectPlatform(url)).toBe("instagram");
  });

  it.each([
    "https://www.tiktok.com/@creator/video/7123456789",
    "https://vm.tiktok.com/ZMabcdef/",
    "https://m.tiktok.com/v/7123456789.html",
  ])("identifies TikTok: %s", (url) => {
    expect(detectPlatform(url)).toBe("tiktok");
  });

  it("rejects an unsupported host", () => {
    expect(() => detectPlatform("https://youtube.com/watch?v=abc")).toThrow(ExtractionError);
  });

  it("rejects a string that is not a URL", () => {
    expect(() => detectPlatform("not a url")).toThrow(ExtractionError);
  });

  it("rejects a non-http scheme", () => {
    expect(() => detectPlatform("file:///etc/passwd")).toThrow(ExtractionError);
  });

  it("matches on hostname, not substring, so a lookalike host is rejected", () => {
    expect(() => detectPlatform("https://tiktok.com.evil.example/video/1")).toThrow(ExtractionError);
    expect(() => detectPlatform("https://example.com/?ref=instagram.com")).toThrow(ExtractionError);
  });
});
