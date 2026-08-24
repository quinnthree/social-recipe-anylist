import type { Platform as CanonicalPlatform } from "../recipe/schema.js";

/**
 * The platforms this layer can actually ingest, derived from the canonical
 * vocabulary rather than restated. The canonical Recipe owns the full set
 * (see ../recipe/schema.ts); ingestion declares the subset it implements.
 *
 * Type-only import, so no runtime dependency is introduced. Deriving rather
 * than duplicating means a canonical rename or removal becomes a compile
 * error here instead of silent drift between two hand-written unions.
 */
export type Platform = Extract<CanonicalPlatform, "instagram" | "tiktok">;

/**
 * Where the extracted text came from. Milestone 1 supports two shapes:
 * a real caption (TikTok oEmbed) and Open Graph metadata (Instagram),
 * which is usually a truncated version of the caption.
 */
export type TextSource = "caption" | "og-description";

export interface SourceContent {
  platform: Platform;
  /** The original URL exactly as the user supplied it. Never a resolved or redirected URL. */
  url: string;
  creator: string | null;
  text: string;
  textSource: TextSource;
}

export interface SocialAdapter {
  platform: Platform;
  fetchSourceContent(url: string): Promise<SourceContent>;
}

/**
 * Why extraction failed, as a stable discriminator. Callers classify on this,
 * never on the human-readable message.
 */
export type ExtractionErrorCode =
  /** The string is not a usable http(s) URL. */
  | "invalid_url"
  /** A valid URL, but not an Instagram or TikTok host. */
  | "unsupported_platform"
  /** The right kind of URL, but the source text could not be obtained. */
  | "source_unavailable";

/**
 * A machine-readable diagnostic for *why* a source was unavailable, one level
 * finer than `ExtractionErrorCode`.
 *
 * This exists so a production failure is diagnosable from telemetry alone. It
 * is a closed vocabulary of our own strings — it never carries a response body,
 * a header, a provider message, or any page content, so it is safe to log and
 * safe to widen later.
 *
 * It deliberately does **not** reach the HTTP response body, which stays a
 * fixed string chosen by status.
 */
export type ExtractionFailureReason =
  /** Instagram served its login or interstitial page instead of a post. */
  | "instagram_login_interstitial"
  /** A redirect destination failed the host, scheme, or hop policy. */
  | "instagram_redirect_rejected"
  /** A post page with no usable Open Graph caption. */
  | "instagram_missing_metadata"
  /** The response resolved to a path that is never a post. */
  | "instagram_non_post_response"
  /** A non-redirect, non-2xx HTTP status. */
  | "instagram_http_status"
  /** The request timed out or the connection failed. */
  | "instagram_timeout"
  /** TikTok's oEmbed endpoint returned no usable caption. */
  | "tiktok_missing_caption"
  /** TikTok's oEmbed endpoint was unreachable or returned an unusable payload. */
  | "tiktok_endpoint_unavailable";

/** Thrown when a platform's source text cannot be obtained or is unusable. */
export class ExtractionError extends Error {
  constructor(
    message: string,
    readonly code: ExtractionErrorCode,
    /** Optional finer-grained diagnostic. Safe to log; never user or page content. */
    readonly reason?: ExtractionFailureReason,
  ) {
    super(message);
    this.name = "ExtractionError";
  }
}
