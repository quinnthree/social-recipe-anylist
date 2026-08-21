import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { instagramAdapter } from "./instagram.js";
import { ExtractionError } from "./types.js";

const POST_URL = "https://www.instagram.com/reel/C8xyzABCdef/";

/** A real post page's metadata, in the shape Instagram actually serves. */
function postPage(
  description = `123 likes, 4 comments - chefquinn on August 1, 2025: "Chicken tinga. 2 lb chicken thighs, 3 chipotles in adobo. Simmer 20 minutes."`,
  title = `chefquinn on Instagram: "Chicken tinga"`,
): string {
  return `<html><head>
    <meta property="og:title" content="${escapeAttribute(title)}" />
    <meta property="og:description" content="${escapeAttribute(description)}" />
  </head><body></body></html>`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

function redirect(location: string, status = 301): Response {
  return new Response(null, { status, headers: { location } });
}

/** Queues responses in order and records every URL the adapter asked for. */
function stubFetch(...responses: Response[]): { requested: string[] } {
  const requested: string[] = [];
  let index = 0;

  vi.stubGlobal("fetch", (input: URL | string) => {
    requested.push(String(input));
    const response = responses[index++];
    if (response === undefined) {
      throw new Error(`unexpected extra request to ${String(input)}`);
    }
    return Promise.resolve(response);
  });

  return { requested };
}

async function expectUnavailable(url = POST_URL): Promise<ExtractionError> {
  let thrown: unknown = null;
  try {
    await instagramAdapter.fetchSourceContent(url);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(ExtractionError);
  const error = thrown as ExtractionError;
  expect(error.code).toBe("source_unavailable");
  return error;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("instagramAdapter: valid content", () => {
  it("extracts the caption and creator from a post page", async () => {
    stubFetch(html(postPage()));

    const content = await instagramAdapter.fetchSourceContent(POST_URL);

    expect(content).toEqual({
      platform: "instagram",
      url: POST_URL,
      creator: "chefquinn",
      text: "Chicken tinga. 2 lb chicken thighs, 3 chipotles in adobo. Simmer 20 minutes.",
      textSource: "og-description",
    });
  });

  it("preserves the caller's URL verbatim even after a redirect", async () => {
    const supplied = "https://instagram.com/reel/C8xyzABCdef/?igsh=abc";
    stubFetch(redirect(POST_URL), html(postPage()));

    const content = await instagramAdapter.fetchSourceContent(supplied);

    expect(content.url).toBe(supplied);
  });

  it("falls back to the raw description when it is not in the quoted shape", async () => {
    stubFetch(html(postPage("Chicken tinga, three ways", "chefquinn on Instagram")));

    const content = await instagramAdapter.fetchSourceContent(POST_URL);

    expect(content.text).toBe("Chicken tinga, three ways");
    expect(content.creator).toBe("chefquinn");
  });
});

describe("instagramAdapter: redirects", () => {
  it("follows a redirect that stays inside the Instagram host policy", async () => {
    const { requested } = stubFetch(
      redirect("https://www.instagram.com/reel/C8xyzABCdef/"),
      html(postPage()),
    );

    const content = await instagramAdapter.fetchSourceContent(
      "https://instagram.com/reel/C8xyzABCdef/",
    );

    expect(content.text).toContain("Chicken tinga");
    expect(requested).toEqual([
      "https://instagram.com/reel/C8xyzABCdef/",
      "https://www.instagram.com/reel/C8xyzABCdef/",
    ]);
  });

  it("resolves a relative Location against the URL that issued it", async () => {
    const { requested } = stubFetch(redirect("/reel/Relative123/"), html(postPage()));

    await instagramAdapter.fetchSourceContent(POST_URL);

    expect(requested[1]).toBe("https://www.instagram.com/reel/Relative123/");
  });

  it("follows the scheme upgrade and apex→www hops a bare http URL produces", async () => {
    const { requested } = stubFetch(
      redirect("https://instagram.com/reel/C8xyzABCdef/"),
      redirect("https://www.instagram.com/reel/C8xyzABCdef/"),
      html(postPage()),
    );

    const content = await instagramAdapter.fetchSourceContent(
      "http://instagram.com/reel/C8xyzABCdef/",
    );

    expect(content.text).toContain("Chicken tinga");
    expect(requested).toHaveLength(3);
  });

  it("rejects a redirect to an external host without requesting it", async () => {
    const { requested } = stubFetch(redirect("https://evil.example/reel/C8xyzABCdef/"));

    const error = await expectUnavailable();

    expect(error.message).toContain("outside Instagram");
    expect(requested).toEqual([POST_URL]);
  });

  it("rejects a protocol-relative redirect that changes host", async () => {
    const { requested } = stubFetch(redirect("//evil.example/reel/x/"));

    await expectUnavailable();

    expect(requested).toEqual([POST_URL]);
  });

  it("rejects a lookalike host that merely contains instagram.com", async () => {
    stubFetch(redirect("https://instagram.com.evil.example/reel/x/"));

    const error = await expectUnavailable();

    expect(error.message).toContain("outside Instagram");
  });

  it("rejects a non-HTTPS redirect even when the host is approved", async () => {
    const { requested } = stubFetch(redirect("http://www.instagram.com/reel/C8xyzABCdef/"));

    const error = await expectUnavailable();

    expect(error.message).toContain("non-HTTPS");
    expect(requested).toEqual([POST_URL]);
  });

  it("rejects a redirect to a javascript: URL", async () => {
    stubFetch(redirect("javascript:alert(1)"));

    const error = await expectUnavailable();

    expect(error.message).toContain("non-HTTPS");
  });

  it("rejects a destination carrying embedded credentials", async () => {
    stubFetch(redirect("https://user:pw@www.instagram.com/reel/C8xyzABCdef/"));

    const error = await expectUnavailable();

    expect(error.message).toContain("credentials");
  });

  it("rejects a malformed Location", async () => {
    stubFetch(redirect("http://"));

    const error = await expectUnavailable();

    expect(error.message).toContain("malformed Location");
  });

  it("rejects a redirect with no Location header", async () => {
    stubFetch(new Response(null, { status: 302 }));

    const error = await expectUnavailable();

    expect(error.message).toContain("without a Location header");
  });

  it("rejects a redirect loop instead of following it forever", async () => {
    const { requested } = stubFetch(
      redirect("https://www.instagram.com/reel/Loop/"),
      redirect("https://www.instagram.com/reel/C8xyzABCdef/"),
    );

    const error = await expectUnavailable();

    expect(error.message).toContain("looped");
    expect(requested).toHaveLength(2);
  });

  it("rejects a chain longer than the redirect limit", async () => {
    const { requested } = stubFetch(
      redirect("https://www.instagram.com/reel/hop1/"),
      redirect("https://www.instagram.com/reel/hop2/"),
      redirect("https://www.instagram.com/reel/hop3/"),
      redirect("https://www.instagram.com/reel/hop4/"),
    );

    const error = await expectUnavailable();

    expect(error.message).toContain("more than 3 redirects");
    // Four requests: the original plus the three redirects allowed.
    expect(requested).toHaveLength(4);
  });

  it("accepts a chain exactly at the redirect limit", async () => {
    stubFetch(
      redirect("https://www.instagram.com/reel/hop1/"),
      redirect("https://www.instagram.com/reel/hop2/"),
      redirect("https://www.instagram.com/reel/hop3/"),
      html(postPage()),
    );

    const content = await instagramAdapter.fetchSourceContent(POST_URL);

    expect(content.text).toContain("Chicken tinga");
  });

  it.each([302, 303, 307, 308])("treats HTTP %i as a redirect", async (status) => {
    const { requested } = stubFetch(
      redirect("https://www.instagram.com/reel/Moved/", status),
      html(postPage()),
    );

    await instagramAdapter.fetchSourceContent(POST_URL);

    expect(requested[1]).toBe("https://www.instagram.com/reel/Moved/");
  });
});

describe("instagramAdapter: login walls and interstitials", () => {
  it("rejects an empty login wall that carries no description at all", async () => {
    stubFetch(html(`<html><head><title>Instagram</title></head><body></body></html>`));

    const error = await expectUnavailable();

    expect(error.message).toContain("no usable og:description caption");
  });

  it.each([
    "Log into Instagram to see photos and videos from friends and discover other accounts you'll love.",
    "Sign up to see photos and videos from your friends.",
    "Create an account or log in to Instagram - Share what you're into with the people who get you.",
    "Sorry, this page isn't available. The link you followed may be broken, or the page may have been removed.",
    "Allow the use of cookies from Instagram on this browser?",
  ])("rejects an interstitial whose og:description is Instagram's own copy: %s", async (copy) => {
    stubFetch(html(postPage(copy, `chefquinn on Instagram: "Chicken tinga"`)));

    const error = await expectUnavailable();

    expect(error.message).toContain("login or interstitial page");
  });

  it("rejects a login page whose copy is in name=description, not og:description", async () => {
    // The live login page (observed 2026-08-21) carries exactly this shape.
    stubFetch(
      html(`<html><head>
        <meta property="og:title" content="Instagram" />
        <meta property="og:description" content="Instagram photos and videos" />
        <meta name="description" content="Create an account or log in to Instagram - Share what you&#039;re into with the people who get you." />
      </head></html>`),
    );

    const error = await expectUnavailable();

    expect(error.message).toContain("login or interstitial page");
  });

  it("rejects a bare 'Instagram' page title, which no post page has", async () => {
    stubFetch(html(postPage("Something that looks like a caption", "Instagram")));

    const error = await expectUnavailable();

    expect(error.message).toContain("login or interstitial page");
  });

  it.each(["Login • Instagram", "Page Not Found • Instagram", "Restricted content"])(
    "rejects the non-post page title %s",
    async (title) => {
      stubFetch(html(postPage("Something that looks like a caption", title)));

      const error = await expectUnavailable();

      expect(error.message).toContain("login or interstitial page");
    },
  );

  it("rejects a redirect that lands on the login path, whatever the page says", async () => {
    stubFetch(
      redirect("https://www.instagram.com/accounts/login/?next=%2Freel%2FC8xyzABCdef%2F", 302),
      html(postPage()),
    );

    const error = await expectUnavailable();

    expect(error.message).toContain("/accounts/login/");
  });

  it("does not mistake a genuine caption that mentions logging in for an interstitial", async () => {
    stubFetch(
      html(
        postPage(
          `12 likes, 1 comment - chefquinn on August 1, 2025: "Sear the chicken, then log the cook time. 3 chipotles."`,
        ),
      ),
    );

    const content = await instagramAdapter.fetchSourceContent(POST_URL);

    expect(content.text).toContain("Sear the chicken");
  });
});

describe("instagramAdapter: existing failure behaviour", () => {
  it("reports a non-OK response as source_unavailable", async () => {
    stubFetch(html("", 404));

    const error = await expectUnavailable();

    expect(error.message).toContain("HTTP 404");
  });

  it("reports a transport failure as source_unavailable", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("socket hang up")));

    const error = await expectUnavailable();

    expect(error.message).toContain("request failed");
  });

  it("reports a whitespace-only description as no usable caption", async () => {
    stubFetch(html(`<meta property="og:description" content="   " />`));

    const error = await expectUnavailable();

    expect(error.message).toContain("no usable og:description caption");
  });

  it("never lets fetch follow redirects on its own", async () => {
    let options: RequestInit | undefined;
    vi.stubGlobal("fetch", (_input: URL | string, init?: RequestInit) => {
      options = init;
      return Promise.resolve(html(postPage()));
    });

    await instagramAdapter.fetchSourceContent(POST_URL);

    expect(options?.redirect).toBe("manual");
  });
});

describe("instagramAdapter: non-post pages", () => {
  it("rejects a profile page, whose description is Instagram's own boilerplate", async () => {
    // Observed live on 2026-08-21 for https://www.instagram.com/instagram/.
    stubFetch(
      html(postPage(
        "686M Followers, 276 Following, 8,562 Posts - See Instagram photos and videos from Instagram (@instagram)",
        "Instagram (@instagram) • Instagram photos and videos",
      )),
    );

    const error = await expectUnavailable("https://www.instagram.com/instagram/");

    expect(error.message).toContain("login or interstitial page");
  });
});
