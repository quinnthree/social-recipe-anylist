export type Platform = "instagram" | "tiktok";

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

/** Thrown when a platform's source text cannot be obtained or is unusable. */
export class ExtractionError extends Error {
  constructor(
    message: string,
    readonly code: ExtractionErrorCode,
  ) {
    super(message);
    this.name = "ExtractionError";
  }
}
