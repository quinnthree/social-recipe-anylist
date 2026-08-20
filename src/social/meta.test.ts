import { describe, expect, it } from "vitest";

import { decodeHtmlEntities, readMetaContent } from "./meta.js";

describe("readMetaContent", () => {
  it("reads a property= meta tag", () => {
    const html = `<head><meta property="og:description" content="Chicken tinga"></head>`;
    expect(readMetaContent(html, "og:description")).toBe("Chicken tinga");
  });

  it("reads a name= meta tag and tolerates attribute order and single quotes", () => {
    const html = `<meta content='Chicken tinga' name='og:description' />`;
    expect(readMetaContent(html, "og:description")).toBe("Chicken tinga");
  });

  it("decodes HTML entities in the content", () => {
    const html = `<meta property="og:description" content="Mac &amp; cheese &#39;n&#39; bacon">`;
    expect(readMetaContent(html, "og:description")).toBe("Mac & cheese 'n' bacon");
  });

  it("returns null when the tag is absent or its content is empty", () => {
    expect(readMetaContent(`<meta property="og:title" content="x">`, "og:description")).toBeNull();
    expect(readMetaContent(`<meta property="og:description" content="   ">`, "og:description")).toBeNull();
  });

  it("does not confuse a different property that shares a prefix", () => {
    const html = `<meta property="og:description:extra" content="wrong">`;
    expect(readMetaContent(html, "og:description")).toBeNull();
  });
});

describe("decodeHtmlEntities", () => {
  it("handles named, decimal, and hex entities", () => {
    expect(decodeHtmlEntities("&lt;a&gt; &#65; &#x42;")).toBe("<a> A B");
  });

  it("leaves unknown entities untouched", () => {
    expect(decodeHtmlEntities("&notarealentity;")).toBe("&notarealentity;");
  });
});
