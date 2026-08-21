import { INSTAGRAM_DOMAIN, isWithinDomain } from "./hosts.js";
import { readMetaContent } from "./meta.js";
import { ExtractionError, type SocialAdapter, type SourceContent } from "./types.js";

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Redirects are followed manually, never by `fetch`, so that every destination
 * is revalidated before it is requested.
 *
 * Legitimate chains measured against Instagram on 2026-08-21 are at most two
 * hops: `http://instagram.com/reel/…` → `https://instagram.com/reel/…` (scheme
 * upgrade) → `https://www.instagram.com/reel/…` (apex → www). An
 * `https://www.instagram.com/…` URL redirects zero times, with or without a
 * trailing slash. Three leaves exactly one hop of headroom — enough for an
 * in-policy interstitial bounce — and nothing more.
 */
const MAX_REDIRECTS = 3;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const REQUEST_HEADERS: Record<string, string> = {
  // Instagram serves Open Graph tags to crawler-shaped requests only.
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "en-US,en;q=0.9",
};

/**
 * Instagram serves Open Graph metadata to unauthenticated clients some of the
 * time. Milestone 1 makes exactly one best-effort request and reports a clear
 * error when that is not enough. A dedicated hosted extraction provider is
 * planned for a later milestone; do not add scraping fallbacks here.
 */
const UNAVAILABLE =
  "Instagram metadata is unavailable for this URL. Milestone 1 only reads Open Graph " +
  "metadata from a single unauthenticated request; a dedicated Instagram extraction " +
  "provider is planned for a later milestone.";

export const instagramAdapter: SocialAdapter = {
  platform: "instagram",

  async fetchSourceContent(url: string): Promise<SourceContent> {
    const { response, finalUrl } = await fetchWithinPolicy(url);

    if (!response.ok) {
      throw unavailable(`HTTP ${response.status}`);
    }

    const html = await response.text();
    const ogDescription = readMetaContent(html, "og:description");
    const ogTitle = readMetaContent(html, "og:title");

    // Before anything is read as caption text. An interstitial that happens to
    // carry a non-empty description must not reach the recipe model dressed up
    // as something a creator wrote.
    const interstitial = interstitialReason(finalUrl, html, ogTitle, ogDescription);
    if (interstitial !== null) {
      throw unavailable(`Instagram served a login or interstitial page (${interstitial})`);
    }

    const text = captionFrom(ogDescription);
    if (text === null) {
      throw unavailable(
        "the response contained no usable og:description caption — " +
          "this usually means Instagram served a login wall",
      );
    }

    return {
      platform: "instagram",
      url,
      creator: creatorFrom(ogDescription, ogTitle),
      text,
      textSource: "og-description",
    };
  },
};

function unavailable(detail: string): ExtractionError {
  return new ExtractionError(`${UNAVAILABLE} (${detail})`, "source_unavailable");
}

/**
 * Fetches `url`, following at most `MAX_REDIRECTS` redirects by hand. Each
 * destination must resolve, be HTTPS, stay inside the approved Instagram host
 * policy, and not have been visited already; anything else fails the request
 * rather than being followed.
 *
 * The returned `finalUrl` is the URL that actually produced the response, which
 * is what the interstitial check needs. It is never surfaced as the recipe's
 * source URL — that stays the URL the user supplied.
 */
async function fetchWithinPolicy(url: string): Promise<{ response: Response; finalUrl: URL }> {
  // One signal for the whole chain, so a redirect sequence cannot extend the
  // total time budget one hop at a time.
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

  let target = approvedTarget(url, { requireHttps: false });
  const visited = new Set<string>([target.href]);

  for (let hop = 0; ; hop++) {
    let response: Response;
    try {
      response = await fetch(target, {
        headers: REQUEST_HEADERS,
        redirect: "manual",
        signal,
      });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw unavailable(`request failed: ${detail}`);
    }

    if (!REDIRECT_STATUSES.has(response.status)) {
      return { response, finalUrl: target };
    }

    void response.body?.cancel().catch(() => {});

    if (hop >= MAX_REDIRECTS) {
      throw unavailable(`more than ${MAX_REDIRECTS} redirects`);
    }

    const location = response.headers.get("location");
    if (location === null || location.trim().length === 0) {
      throw unavailable(`HTTP ${response.status} redirect without a Location header`);
    }

    let resolved: URL;
    try {
      // Relative values are resolved against the URL that issued the redirect,
      // which is also what makes a protocol-relative `//host/path` visible as
      // the host change it is.
      resolved = new URL(location, target);
    } catch {
      throw unavailable(`a redirect pointed at a malformed Location`);
    }

    target = approvedTarget(resolved.href, { requireHttps: true });

    if (visited.has(target.href)) {
      throw unavailable("the redirect chain looped");
    }
    visited.add(target.href);
  }
}

/**
 * Parses a URL and admits it only if it is inside the approved Instagram host
 * policy. Redirect destinations must additionally be HTTPS; the caller-supplied
 * URL is left to `detectPlatform`'s scheme rule, which this does not tighten.
 */
function approvedTarget(value: string, { requireHttps }: { requireHttps: boolean }): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw unavailable("a URL in the redirect chain could not be parsed");
  }

  const allowedSchemes = requireHttps ? ["https:"] : ["https:", "http:"];
  if (!allowedSchemes.includes(parsed.protocol)) {
    throw unavailable(`refused a non-HTTPS destination ("${parsed.protocol}")`);
  }

  if (parsed.username !== "" || parsed.password !== "") {
    throw unavailable("refused a destination carrying embedded credentials");
  }

  if (!isWithinDomain(parsed.hostname, INSTAGRAM_DOMAIN)) {
    throw unavailable(`refused a destination outside Instagram ("${parsed.hostname}")`);
  }

  return parsed;
}

/**
 * Instagram paths that are never a post. A rejection list rather than an
 * allowlist, because post URLs take several legitimate shapes
 * (`/reel/…`, `/p/…`, `/tv/…`, `/share/…`, `/<user>/reel/…`).
 */
const INTERSTITIAL_PATH =
  /^\/(?:accounts|challenge|privacy|terms|legal|emails|password|two_factor|explore\/login)(?:\/|$)/i;

/**
 * `og:title` values that only a non-post page produces. A real post titles
 * itself after its creator — `username on Instagram: "…"` or
 * `Name (@handle) • Instagram photos and videos`. A bare "Instagram" is what
 * the login page and the "page isn't available" page both serve
 * (observed 2026-08-21).
 */
const INTERSTITIAL_TITLE =
  /^(?:instagram|(?:log\s?in|login|sign\s?up|signup|page not found|restricted content)\s*(?:[•·|-]\s*instagram)?)$/i;

/**
 * Boilerplate Instagram writes on its own login, consent, error, and profile
 * pages. Deterministic string matching, not a heuristic score, and never a
 * confidence judgement: either the page says one of these things or it does not.
 *
 * The start-anchored pattern is safe against a caption that merely opens with
 * "Sign up for my newsletter", because a real post's description is prefixed by
 * Instagram's own `N likes, M comments - user on DATE:` header. A caption never
 * reaches position zero.
 */
const INTERSTITIAL_TEXT: readonly RegExp[] = [
  /^(?:log\s?in|login|log into|sign\s?up|signup|create an account)\b/i,
  /\bsee photos and videos from your friends\b/i,
  /\bto see photos and videos from friends\b/i,
  /\blog in(?:to)? instagram to see\b/i,
  /\bsorry,?\s*this page isn'?t available\b/i,
  /\bthe link you followed may be broken\b/i,
  /\bthis (?:account|content|post) is private\b/i,
  /^restricted content\b/i,
  /\byou must be \d+ (?:years? old|or older)\b/i,
  /\ballow the use of cookies\b/i,
  // A profile page rather than a post: its description is Instagram's own
  // follower summary, which is not something a creator wrote either.
  /\bsee instagram photos and videos from\b/i,
];

/**
 * Deterministic detection of a login wall or interstitial. Returns the reason
 * when the response is one, or null when it looks like a real post page.
 *
 * Three independent signals, any of which is sufficient:
 *   1. the response came from a path that is never a post;
 *   2. `og:title` is a page title only a non-post page has;
 *   3. any description metadata — including `name="description"`, which the
 *      current live login page carries instead of `og:description` — matches
 *      Instagram's own interstitial copy.
 */
function interstitialReason(
  finalUrl: URL,
  html: string,
  ogTitle: string | null,
  ogDescription: string | null,
): string | null {
  if (INTERSTITIAL_PATH.test(finalUrl.pathname)) {
    return `resolved to ${finalUrl.pathname}`;
  }

  if (ogTitle !== null && INTERSTITIAL_TITLE.test(ogTitle.trim())) {
    return "the page title is not a post title";
  }

  const descriptions = [ogDescription, readMetaContent(html, "description")];
  for (const description of descriptions) {
    if (description === null) continue;
    const normalized = description.replace(/\s+/g, " ").trim();
    if (INTERSTITIAL_TEXT.some((pattern) => pattern.test(normalized))) {
      return "the description metadata is Instagram's own interstitial copy";
    }
  }

  return null;
}

/**
 * Instagram's og:description looks like:
 *   `123 likes, 4 comments - username on August 1, 2025: "caption text".`
 * Lift the quoted caption when that shape is present, otherwise fall back to
 * the raw description. Returns null when nothing usable remains.
 */
function captionFrom(ogDescription: string | null): string | null {
  if (ogDescription === null) return null;

  const quoted = /:\s*[“"](.+)[”"]\.?\s*$/s.exec(ogDescription);
  const caption = (quoted?.[1] ?? ogDescription).trim();

  return caption.length > 0 ? caption : null;
}

function creatorFrom(ogDescription: string | null, ogTitle: string | null): string | null {
  const fromDescription = /[-–—]\s*([^\s][^-–—]*?)\s+on\s/.exec(ogDescription ?? "");
  if (fromDescription?.[1]) return fromDescription[1].trim();

  const fromTitle = /^(.+?)\s+on\s+Instagram\b/.exec(ogTitle ?? "");
  if (fromTitle?.[1]) return fromTitle[1].trim();

  return null;
}
