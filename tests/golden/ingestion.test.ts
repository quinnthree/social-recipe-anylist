import { afterEach, describe, expect, it, vi } from "vitest";

import { GOLDEN_CORPUS, FAILING_FIXTURES, INGESTIBLE_FIXTURES } from "../../fixtures/corpus.js";
import { fetchSourceContent } from "../../src/social/index.js";
import { ExtractionError } from "../../src/social/types.js";
import { stubFetchFor } from "../support/fetch-stub.js";

/**
 * Recorded upstream response → SourceContent. This half of the pipeline is
 * fully deterministic, so the whole corpus is asserted exactly. No live calls:
 * every fixture serves its recorded body through a stubbed fetch, and any other
 * URL throws.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ingestion produces the golden SourceContent", () => {
  it.each(INGESTIBLE_FIXTURES.map((f) => [f.id, f] as const))("%s", async (_id, fixture) => {
    stubFetchFor(fixture);

    await expect(fetchSourceContent(fixture.url)).resolves.toEqual(fixture.expectedSourceContent);
  });
});

describe("ingestion preserves provenance", () => {
  it.each(INGESTIBLE_FIXTURES.map((f) => [f.id, f] as const))(
    "%s keeps the submitted URL verbatim",
    async (_id, fixture) => {
      stubFetchFor(fixture);
      const content = await fetchSourceContent(fixture.url);

      expect(content.url).toBe(fixture.url);
    },
  );

  it("requests TikTok's oEmbed endpoint with the URL encoded, not the post itself", async () => {
    const fixture = INGESTIBLE_FIXTURES.find((f) => f.recordedSource.kind === "tiktok-oembed");
    if (fixture === undefined) throw new Error("The corpus has no TikTok fixture.");

    const log = stubFetchFor(fixture);
    await fetchSourceContent(fixture.url);

    expect(log.urls).toEqual([
      `https://www.tiktok.com/oembed?url=${encodeURIComponent(fixture.url)}`,
    ]);
  });

  it("requests the Instagram post URL directly", async () => {
    const fixture = INGESTIBLE_FIXTURES.find((f) => f.recordedSource.kind === "instagram-html");
    if (fixture === undefined) throw new Error("The corpus has no Instagram fixture.");

    const log = stubFetchFor(fixture);
    await fetchSourceContent(fixture.url);

    expect(log.urls).toEqual([fixture.url]);
  });
});

describe("ingestion rejects the failure fixtures", () => {
  const ingestionFailures = FAILING_FIXTURES.filter((f) => f.expectedFailure?.extractionCode !== null);

  it.each(ingestionFailures.map((f) => [f.id, f] as const))(
    "%s fails with the expected code",
    async (_id, fixture) => {
      stubFetchFor(fixture);

      const error = await fetchSourceContent(fixture.url).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ExtractionError);
      expect((error as ExtractionError).code).toBe(fixture.expectedFailure?.extractionCode);
    },
  );

  it("never contacts the network for a URL rejected at platform detection", async () => {
    const notFetched = GOLDEN_CORPUS.filter((f) => f.recordedSource.kind === "never-fetched");
    expect(notFetched.length).toBeGreaterThan(0);

    for (const fixture of notFetched) {
      const log = stubFetchFor(fixture);
      await fetchSourceContent(fixture.url).catch(() => undefined);

      expect(log.urls).toEqual([]);
    }
  });

  it("makes exactly one request for a login wall, and calls no model", async () => {
    // A blocked Instagram post must cost one HTTP request and nothing else.
    const fixture = GOLDEN_CORPUS.find((f) => f.id === "instagram-login-wall");
    if (fixture === undefined) throw new Error("Missing the login-wall fixture.");

    const log = stubFetchFor(fixture);
    await fetchSourceContent(fixture.url).catch(() => undefined);

    expect(log.urls).toHaveLength(1);
  });
});
