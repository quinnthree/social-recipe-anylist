import { afterEach, describe, expect, it, vi } from "vitest";

import { fixture } from "../../fixtures/corpus.js";
import { fetchSourceContent } from "../../src/social/index.js";
import { ExtractionError } from "../../src/social/types.js";
import { stubFetchChain, stubFetchFor, stubFetchResponse } from "../support/fetch-stub.js";

/**
 * Instagram public-endpoint hardening (architecture.md, "required before public
 * exposure").
 *
 * NOT IMPLEMENTED. The adapter passes `redirect: "follow"`, which hands the
 * entire chain to undici — so there is no hop to validate, no place to enforce
 * an Instagram host policy, and no bound of our own on the chain length.
 *
 * Active tests below record exactly that, so the gap is visible and so the
 * specification fails loudly the moment the adapter changes. The skipped block
 * is the approved policy, written out.
 *
 * No production fix is implemented here.
 */

const POST_URL = "https://www.instagram.com/reel/Cq1incomplete/";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function failureFor(url: string): Promise<ExtractionError> {
  const error = await fetchSourceContent(url).catch((thrown: unknown) => thrown);

  expect(error).toBeInstanceOf(ExtractionError);
  return error as ExtractionError;
}

describe("current redirect handling delegates everything", () => {
  it("asks undici to follow redirects, so no hop is ours to inspect", async () => {
    const instagram = fixture("instagram-incomplete-caption");
    const log = stubFetchFor(instagram);
    await fetchSourceContent(instagram.url);

    expect(log.calls[0]?.init["redirect"]).toBe("follow");
  });

  it("makes exactly one observable request however long the real chain is", async () => {
    // The consequence of `redirect: "follow"`: intermediate destinations never
    // reach our code, so an external or downgraded hop cannot be rejected.
    const instagram = fixture("instagram-incomplete-caption");
    const log = stubFetchFor(instagram);
    await fetchSourceContent(instagram.url);

    expect(log.urls).toHaveLength(1);
  });

  it("sends a browser-shaped User-Agent, which is what makes a login wall likely", async () => {
    const instagram = fixture("instagram-incomplete-caption");
    const log = stubFetchFor(instagram);
    await fetchSourceContent(instagram.url);

    const headers = log.calls[0]?.init["headers"] as Record<string, string> | undefined;
    expect(headers?.["User-Agent"]).toContain("Mozilla/5.0");
  });

  it("trusts the response body without checking where it came from", async () => {
    // The adapter never reads `response.url`, so it cannot tell whether the
    // body it parsed came from instagram.com or from wherever a redirect chain
    // ended. Any page serving og:description is accepted as a caption.
    stubFetchResponse(
      200,
      `<meta property="og:title" content="attacker on Instagram: &quot;x&quot;" />` +
        `<meta property="og:description" content="attacker on August 1, 2026: &quot;RECIPE FROM SOMEWHERE ELSE ENTIRELY&quot;." />`,
    );

    const content = await fetchSourceContent(POST_URL);

    expect(content.platform).toBe("instagram");
    expect(content.text).toBe("RECIPE FROM SOMEWHERE ELSE ENTIRELY");
    // Provenance records the URL we asked for, not the one that answered.
    expect(content.url).toBe(POST_URL);
  });

  it.each([301, 302, 303, 307, 308])(
    "treats a bare %i reaching the adapter as source_unavailable",
    async (status) => {
      // Unreachable today, because undici resolves redirects first. Recorded as
      // the baseline for the moment redirect handling becomes manual: a 3xx is
      // not `ok`, so it currently falls into the generic unavailable path
      // rather than into any redirect logic.
      stubFetchChain([{ status, location: "https://www.instagram.com/accounts/login/" }]);

      expect((await failureFor(POST_URL)).code).toBe("source_unavailable");
    },
  );
});

describe("login walls and interstitials", () => {
  it("rejects a login wall that carries no usable description", async () => {
    const wall = fixture("instagram-login-wall");
    stubFetchFor(wall);

    expect((await failureFor(wall.url)).code).toBe("source_unavailable");
  });

  it("QA-002: accepts an interstitial whose description is boilerplate", async () => {
    // "Never pass arbitrary interstitial description text to the recipe model
    // as though it were a creator caption" — not implemented. The sign-in blurb
    // is accepted as a caption and billed to Anthropic as one.
    const blurb = fixture("instagram-login-blurb");
    stubFetchFor(blurb);

    const content = await fetchSourceContent(blurb.url);

    expect(content.textSource).toBe("og-description");
    expect(content.text).toContain("Sign in to check out");
    expect(content.creator).toBeNull();
  });

  it("cannot distinguish an interstitial from a caption by any current signal", async () => {
    // Both produce a SourceContent of exactly the same shape. Nothing marks one
    // as suspect, which is why the detection has to live in the adapter.
    const blurb = fixture("instagram-login-blurb");
    const real = fixture("instagram-incomplete-caption");

    stubFetchFor(blurb);
    const interstitial = await fetchSourceContent(blurb.url);
    vi.unstubAllGlobals();

    stubFetchFor(real);
    const caption = await fetchSourceContent(real.url);

    expect(Object.keys(interstitial).sort()).toEqual(Object.keys(caption).sort());
    expect(interstitial.textSource).toBe(caption.textSource);
  });
});

/**
 * ENABLE when the Instagram adapter implements the approved hardening. It will
 * need `redirect: "manual"` to see each hop, at which point the chain becomes
 * several observable fetches and these assertions become meaningful.
 *
 * Delete the "current redirect handling delegates everything" block above when
 * enabling — its whole subject is the absence of this policy.
 */
describe.skip("Instagram redirect policy — specification", () => {
  const LOGIN_WALL_BODY = `<meta property="og:description" content="   " />`;
  const CAPTION_BODY =
    `<meta property="og:description" ` +
    `content="12 likes, 1 comments - pastachef on August 3, 2026: &quot;CACIO E PEPE 300 g spaghetti. Toast the pepper.&quot;." />`;

  it("follows a redirect that stays within the Instagram host policy", async () => {
    const log = stubFetchChain([
      { status: 301, location: "https://www.instagram.com/reel/Cq1incomplete/?hl=en" },
      { status: 200, body: CAPTION_BODY },
    ]);

    const content = await fetchSourceContent(POST_URL);

    expect(content.platform).toBe("instagram");
    expect(log.urls).toHaveLength(2);
    // Provenance stays the URL the user shared, never the resolved one.
    expect(content.url).toBe(POST_URL);
  });

  it("resolves a relative Location against the current URL", async () => {
    const log = stubFetchChain([
      { status: 302, location: "/reel/Cq1incomplete/?hl=en" },
      { status: 200, body: CAPTION_BODY },
    ]);

    await fetchSourceContent(POST_URL);

    expect(log.urls[1]).toBe("https://www.instagram.com/reel/Cq1incomplete/?hl=en");
  });

  it("resolves a protocol-relative Location as https, not http", async () => {
    const log = stubFetchChain([
      { status: 302, location: "//www.instagram.com/reel/other/" },
      { status: 200, body: CAPTION_BODY },
    ]);

    await fetchSourceContent(POST_URL);

    expect(log.urls[1]).toBe("https://www.instagram.com/reel/other/");
  });

  it.each([
    ["a different origin", "https://evil.example/recipe"],
    ["a lookalike host", "https://instagram.com.evil.example/reel/x/"],
    ["a subdomain-suffix trick", "https://notinstagram.com/reel/x/"],
  ])("rejects an external redirect to %s", async (_label, location) => {
    const log = stubFetchChain([{ status: 302, location }, { status: 200, body: CAPTION_BODY }]);

    expect((await failureFor(POST_URL)).code).toBe("source_unavailable");
    // Rejected before the off-policy destination is ever requested.
    expect(log.urls).toHaveLength(1);
  });

  it("rejects a redirect that downgrades to http", async () => {
    const log = stubFetchChain([
      { status: 302, location: "http://www.instagram.com/reel/Cq1incomplete/" },
      { status: 200, body: CAPTION_BODY },
    ]);

    expect((await failureFor(POST_URL)).code).toBe("source_unavailable");
    expect(log.urls).toHaveLength(1);
  });

  it.each([
    ["an empty Location", ""],
    ["a non-URL Location", "not a url"],
    ["a javascript: Location", "javascript:alert(1)"],
    ["a data: Location", "data:text/html,<h1>x"],
  ])("rejects %s", async (_label, location) => {
    stubFetchChain([{ status: 302, location }, { status: 200, body: CAPTION_BODY }]);

    expect((await failureFor(POST_URL)).code).toBe("source_unavailable");
  });

  it("rejects a 3xx with no Location header at all", async () => {
    stubFetchChain([{ status: 302 }]);

    expect((await failureFor(POST_URL)).code).toBe("source_unavailable");
  });

  it("bounds the redirect chain rather than following it indefinitely", async () => {
    const loop = Array.from({ length: 30 }, () => ({
      status: 302,
      location: "https://www.instagram.com/reel/Cq1incomplete/",
    }));
    const log = stubFetchChain(loop);

    expect((await failureFor(POST_URL)).code).toBe("source_unavailable");
    expect(log.urls.length).toBeLessThanOrEqual(10);
  });

  it("stops a self-referential redirect loop", async () => {
    const log = stubFetchChain(
      Array.from({ length: 30 }, () => ({ status: 302, location: POST_URL })),
    );

    expect((await failureFor(POST_URL)).code).toBe("source_unavailable");
    expect(log.urls.length).toBeLessThanOrEqual(10);
  });

  it("rejects a redirect to the login wall as an unavailable source", async () => {
    stubFetchChain([
      { status: 302, location: "https://www.instagram.com/accounts/login/" },
      { status: 200, body: LOGIN_WALL_BODY },
    ]);

    expect((await failureFor(POST_URL)).code).toBe("source_unavailable");
  });

  it("rejects an interstitial description instead of treating it as a caption", async () => {
    // The other half of the approved hardening, and the fix for QA-002.
    const blurb = fixture("instagram-login-blurb");
    stubFetchFor(blurb);

    expect((await failureFor(blurb.url)).code).toBe("source_unavailable");
  });

  it("makes no Anthropic call for any rejected interstitial", async () => {
    // Rejection must happen in the adapter, before extraction is paid for.
    const blurb = fixture("instagram-login-blurb");
    const log = stubFetchFor(blurb);

    await failureFor(blurb.url);

    expect(log.urls).toHaveLength(1);
  });
});
