import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchSourceContent } from "../../src/social/index.js";
import { ExtractionError, type ExtractionFailureReason } from "../../src/social/types.js";
import { stubFetchChain, stubFetchRejection, stubFetchResponse } from "../support/fetch-stub.js";

/**
 * Machine-readable failure diagnostics (live Vercel investigation, 2026-08-24).
 *
 * Production collapsed every Instagram failure into `extraction_failed` with a
 * null platform, which made a live failure undiagnosable without reproducing it
 * by hand. These assert the reason vocabulary is populated and, just as
 * importantly, that it stays a closed set of our own strings — no page content,
 * no headers, no provider text.
 */

const REEL = "https://www.instagram.com/reel/DcUBY0cQsPR/";

const POST_PAGE = `<html><head>
  <meta property="og:title" content="cook on Instagram: &quot;Brownies&quot;" />
  <meta property="og:description" content="1 likes, 0 comments - cook on August 21, 2026: &quot;Brownies&quot;." />
</head></html>`;

/** What Instagram now serves to a browser-shaped User-Agent: a JS shell. */
const JS_SHELL = `<html><head><title>Instagram</title>
  <meta name="theme-color" content="#ffffff" />
</head><body><div id="root"></div></body></html>`;

const LOGIN_WALL = `<html><head>
  <meta property="og:title" content="Instagram" />
  <meta property="og:description" content="Log in to see photos and videos from friends." />
</head></html>`;

async function reasonOf(url = REEL): Promise<ExtractionFailureReason | undefined> {
  try {
    await fetchSourceContent(url);
  } catch (error) {
    expect(error).toBeInstanceOf(ExtractionError);
    return (error as ExtractionError).reason;
  }
  return undefined;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Instagram failure reasons", () => {
  it("reports instagram_missing_metadata for the JS shell served to browsers", async () => {
    // The exact production failure: HTTP 200, no og: tags, bare title.
    stubFetchResponse(200, JS_SHELL);

    expect(await reasonOf()).toBe("instagram_missing_metadata");
  });

  it("reports instagram_login_interstitial for a login wall", async () => {
    stubFetchResponse(200, LOGIN_WALL);

    expect(await reasonOf()).toBe("instagram_login_interstitial");
  });

  it("reports instagram_http_status for a non-2xx response", async () => {
    stubFetchResponse(404, "");

    expect(await reasonOf()).toBe("instagram_http_status");
  });

  it("reports instagram_redirect_rejected for an off-Instagram destination", async () => {
    stubFetchChain([{ status: 302, location: "https://evil.example.com/reel/1" }]);

    expect(await reasonOf()).toBe("instagram_redirect_rejected");
  });

  it("reports instagram_redirect_rejected for a non-HTTPS destination", async () => {
    stubFetchChain([{ status: 302, location: "http://www.instagram.com/reel/1/" }]);

    expect(await reasonOf()).toBe("instagram_redirect_rejected");
  });

  it("reports instagram_non_post_response when the URL resolves to a login path", async () => {
    stubFetchChain([
      { status: 302, location: "https://www.instagram.com/accounts/login/" },
      { status: 200, body: POST_PAGE },
    ]);

    expect(await reasonOf()).toBe("instagram_non_post_response");
  });

  it("reports a reason for a transport failure", async () => {
    stubFetchRejection(new TypeError("fetch failed"));

    expect(await reasonOf()).toBe("instagram_redirect_rejected");
  });

  it("succeeds with no reason when the page is a real post", async () => {
    stubFetchResponse(200, POST_PAGE);

    const content = await fetchSourceContent(REEL);
    expect(content.text).toBe("Brownies");
  });
});

describe("the reason vocabulary is a closed set of our own strings", () => {
  const ALLOWED = new Set<string>([
    "instagram_login_interstitial",
    "instagram_redirect_rejected",
    "instagram_missing_metadata",
    "instagram_non_post_response",
    "instagram_http_status",
    "instagram_timeout",
    "tiktok_missing_caption",
    "tiktok_endpoint_unavailable",
  ]);

  it.each([
    ["js shell", JS_SHELL],
    ["login wall", LOGIN_WALL],
  ])("never leaks page content through the reason (%s)", async (_label, body) => {
    stubFetchResponse(200, body);
    const reason = await reasonOf();

    expect(reason).toBeDefined();
    expect(ALLOWED.has(reason as string)).toBe(true);
  });

  it("never carries the caption, a header, or a cookie", async () => {
    stubFetchResponse(200, JS_SHELL);
    const reason = (await reasonOf()) ?? "";

    expect(reason).not.toMatch(/set-cookie|sessionid|csrftoken|<|>|https?:\/\//i);
  });
});
