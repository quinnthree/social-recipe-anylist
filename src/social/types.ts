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
