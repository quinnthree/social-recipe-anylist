import { readMetaContent } from "./meta.js";
import { ExtractionError, type SocialAdapter, type SourceContent } from "./types.js";

const REQUEST_TIMEOUT_MS = 15_000;

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
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          // Instagram serves Open Graph tags to crawler-shaped requests only.
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new ExtractionError(`${UNAVAILABLE} (request failed: ${detail})`);
    }

    if (!response.ok) {
      throw new ExtractionError(`${UNAVAILABLE} (HTTP ${response.status})`);
    }

    const html = await response.text();
    const ogDescription = readMetaContent(html, "og:description");
    const ogTitle = readMetaContent(html, "og:title");

    const text = captionFrom(ogDescription);
    if (text === null) {
      throw new ExtractionError(
        `${UNAVAILABLE} (the response contained no usable og:description caption — ` +
          `this usually means Instagram served a login wall)`,
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
