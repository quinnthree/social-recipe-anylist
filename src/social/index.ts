import { INSTAGRAM_DOMAIN, TIKTOK_DOMAIN, isWithinDomain } from "./hosts.js";
import { instagramAdapter } from "./instagram.js";
import { tiktokAdapter } from "./tiktok.js";
import { ExtractionError, type Platform, type SocialAdapter, type SourceContent } from "./types.js";

export { ExtractionError };
export type { Platform, SocialAdapter, SourceContent, TextSource } from "./types.js";

// One adapter per ingestible platform. Platform is derived from the canonical
// vocabulary and narrowed to what this layer implements (see ./types.ts), so
// this map is exhaustive by construction: a canonical platform we cannot yet
// ingest — currently "youtube" — is absent from Platform and therefore not
// required here. An Exclude<> would be redundant.
const ADAPTERS: Record<Platform, SocialAdapter> = {
  instagram: instagramAdapter,
  tiktok: tiktokAdapter,
};

const PLATFORM_DOMAINS: ReadonlyArray<readonly [string, Platform]> = [
  [INSTAGRAM_DOMAIN, "instagram"],
  [TIKTOK_DOMAIN, "tiktok"],
];

/**
 * Identifies the platform from the URL's hostname. Matching is done against the
 * parsed hostname rather than the raw string so that a URL merely *containing*
 * "tiktok.com" somewhere in its path or query cannot be misrouted. The rule
 * itself lives in ./hosts.ts, because the Instagram adapter applies the same
 * one to every redirect destination.
 */
export function detectPlatform(url: string): Platform {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ExtractionError(`"${url}" is not a valid URL.`, "invalid_url");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ExtractionError(
      `Unsupported URL scheme "${parsed.protocol}". Expected http or https.`,
      "invalid_url",
    );
  }

  for (const [domain, platform] of PLATFORM_DOMAINS) {
    if (isWithinDomain(parsed.hostname, domain)) return platform;
  }

  throw new ExtractionError(
    `Unsupported platform for host "${parsed.hostname}". Expected an Instagram or TikTok URL.`,
    "unsupported_platform",
  );
}

/** Identifies the platform and delegates to that platform's adapter. */
export async function fetchSourceContent(url: string): Promise<SourceContent> {
  const platform = detectPlatform(url);
  return ADAPTERS[platform].fetchSourceContent(url);
}
