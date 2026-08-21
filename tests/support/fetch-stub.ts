import { vi } from "vitest";

import type { GoldenFixture } from "../../fixtures/types.js";
import { readRecordedBody } from "../../fixtures/types.js";

const TIKTOK_OEMBED_PREFIX = "https://www.tiktok.com/oembed?url=";

export interface FetchLog {
  /** Every URL the code under test requested, in order. */
  urls: string[];
}

function install(handler: (url: string) => Response | Promise<Response>): FetchLog {
  const log: FetchLog = { urls: [] };

  vi.stubGlobal("fetch", async (input: unknown, _init?: unknown): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    log.urls.push(url);
    return handler(url);
  });

  return log;
}

/**
 * Fails the test if anything reaches the network. Install this in any suite that
 * should be fully offline — it turns an accidental live call into an immediate,
 * legible failure instead of a slow test or a flake.
 */
export function forbidNetwork(): FetchLog {
  return install((url) => {
    throw new Error(
      `Automated tests must not make live calls. Something tried to fetch ${url}. ` +
        `Serve a recorded fixture through tests/support/fetch-stub.ts instead.`,
    );
  });
}

/**
 * Serves this fixture's recorded upstream response, and nothing else. Any other
 * URL throws, so a test cannot silently pass by hitting a different endpoint.
 */
export function stubFetchFor(fixture: GoldenFixture): FetchLog {
  const { recordedSource } = fixture;

  if (recordedSource.kind === "never-fetched") {
    return forbidNetwork();
  }

  const expectedUrl =
    recordedSource.kind === "tiktok-oembed"
      ? `${TIKTOK_OEMBED_PREFIX}${encodeURIComponent(fixture.url)}`
      : fixture.url;

  const contentType =
    recordedSource.kind === "tiktok-oembed" ? "application/json" : "text/html; charset=utf-8";

  return install((url) => {
    if (url !== expectedUrl) {
      throw new Error(
        `Fixture "${fixture.id}" only serves ${expectedUrl}, but the code requested ${url}.`,
      );
    }
    return new Response(readRecordedBody(recordedSource.file), {
      status: recordedSource.status,
      headers: { "content-type": contentType },
    });
  });
}

/** A one-off response, for transport-failure cases that have no recorded body. */
export function stubFetchResponse(status: number, body = ""): FetchLog {
  return install(() => new Response(body, { status }));
}

/** A transport-level failure: DNS, reset connection, timeout. */
export function stubFetchRejection(error: unknown): FetchLog {
  return install(() => {
    throw error;
  });
}
