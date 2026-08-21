/**
 * The approved host policy for social ingestion, defined in one place.
 *
 * `detectPlatform` uses it to decide whether a URL is ours at all; the
 * Instagram adapter re-checks every redirect destination against the same
 * rule. Sharing the definition is the point — a redirect must not be able to
 * leave the host set that admitted the original URL because two hand-written
 * checks drifted apart.
 */

export const INSTAGRAM_DOMAIN = "instagram.com";
export const TIKTOK_DOMAIN = "tiktok.com";

/**
 * True when `hostname` is the registrable domain itself or a subdomain of it.
 * Always applied to a parsed hostname, never to a raw URL string, so a
 * lookalike host such as `instagram.com.evil.example` does not match.
 */
export function isWithinDomain(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}
