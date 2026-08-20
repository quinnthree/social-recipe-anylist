import { instagramAdapter } from "./instagram.js";
import { tiktokAdapter } from "./tiktok.js";
import { ExtractionError, type Platform, type SocialAdapter, type SourceContent } from "./types.js";

export { ExtractionError };
export type { Platform, SocialAdapter, SourceContent, TextSource } from "./types.js";

const ADAPTERS: Record<Platform, SocialAdapter> = {
  instagram: instagramAdapter,
  tiktok: tiktokAdapter,
};

const PLATFORM_DOMAINS: ReadonlyArray<readonly [string, Platform]> = [
  ["instagram.com", "instagram"],
  ["tiktok.com", "tiktok"],
];

/**
 * Identifies the platform from the URL's hostname. Matching is done against the
 * parsed hostname rather than the raw string so that a URL merely *containing*
 * "tiktok.com" somewhere in its path or query cannot be misrouted.
 */
export function detectPlatform(url: string): Platform {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ExtractionError(`"${url}" is not a valid URL.`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ExtractionError(`Unsupported URL scheme "${parsed.protocol}". Expected http or https.`);
  }

  const hostname = parsed.hostname.toLowerCase();
  for (const [domain, platform] of PLATFORM_DOMAINS) {
    if (hostname === domain || hostname.endsWith(`.${domain}`)) return platform;
  }

  throw new ExtractionError(
    `Unsupported platform for host "${parsed.hostname}". Expected an Instagram or TikTok URL.`,
  );
}

/** Identifies the platform and delegates to that platform's adapter. */
export async function fetchSourceContent(url: string): Promise<SourceContent> {
  const platform = detectPlatform(url);
  return ADAPTERS[platform].fetchSourceContent(url);
}
