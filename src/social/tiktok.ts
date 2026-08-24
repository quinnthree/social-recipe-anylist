import { z } from "zod";
import { ExtractionError, type SocialAdapter, type SourceContent } from "./types.js";

const OEMBED_ENDPOINT = "https://www.tiktok.com/oembed";
const REQUEST_TIMEOUT_MS = 15_000;

/** TikTok's public oEmbed response. External data, so it is validated before use. */
const OEmbedResponseSchema = z.object({
  title: z.string().optional(),
  author_name: z.string().optional(),
  author_unique_id: z.string().optional(),
});

export const tiktokAdapter: SocialAdapter = {
  platform: "tiktok",

  async fetchSourceContent(url: string): Promise<SourceContent> {
    const endpoint = `${OEMBED_ENDPOINT}?url=${encodeURIComponent(url)}`;

    let response: Response;
    try {
      response = await fetch(endpoint, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new ExtractionError(
        `Could not reach TikTok's oEmbed endpoint for ${url}: ${describe(cause)}`,
        "source_unavailable",
        "tiktok_endpoint_unavailable",
      );
    }

    if (!response.ok) {
      throw new ExtractionError(
        `TikTok's oEmbed endpoint returned ${response.status} for ${url}. ` +
          `The post may be private, removed, or region-restricted.`,
        "source_unavailable",
        "tiktok_endpoint_unavailable",
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ExtractionError(
        `TikTok's oEmbed endpoint returned a non-JSON response for ${url}.`,
        "source_unavailable",
        "tiktok_endpoint_unavailable",
      );
    }

    const parsed = OEmbedResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ExtractionError(
        `TikTok's oEmbed response for ${url} did not match the expected shape.`,
        "source_unavailable",
        "tiktok_endpoint_unavailable",
      );
    }

    const text = parsed.data.title?.trim() ?? "";
    if (text.length === 0) {
      throw new ExtractionError(
        `TikTok returned no caption text for ${url}. There is nothing to extract a recipe from.`,
        "source_unavailable",
        "tiktok_missing_caption",
      );
    }

    const creator = parsed.data.author_unique_id?.trim() || parsed.data.author_name?.trim() || null;

    return {
      platform: "tiktok",
      url,
      creator,
      text,
      textSource: "caption",
    };
  },
};

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
