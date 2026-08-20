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

/** Thrown when a platform's source text cannot be obtained or is unusable. */
export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionError";
  }
}
