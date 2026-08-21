import { vi } from "vitest";

import type { GoldenFixture } from "../../fixtures/types.js";
import { readRecordedBody } from "../../fixtures/types.js";

const TIKTOK_OEMBED_PREFIX = "https://www.tiktok.com/oembed?url=";

export interface FetchCall {
  url: string;
  /** The RequestInit the adapter passed, so redirect policy can be asserted. */
  init: Record<string, unknown>;
}

export interface FetchLog {
  /** Every URL the code under test requested, in order. */
  urls: string[];
  /** The same requests, with the options each was made with. */
  calls: FetchCall[];
}

function install(
  handler: (url: string, init: Record<string, unknown>) => Response | Promise<Response>,
): FetchLog {
  const log: FetchLog = { urls: [], calls: [] };

  vi.stubGlobal("fetch", async (input: unknown, init?: unknown): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    const options = (init ?? {}) as Record<string, unknown>;

    log.urls.push(url);
    log.calls.push({ url, init: options });

    return handler(url, options);
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

/** One hop of a redirect chain, as an upstream server would answer it. */
export interface Hop {
  status: number;
  /** The raw Location header, exactly as served. Omit for a terminal response. */
  location?: string;
  body?: string;
}

/**
 * Serves a redirect chain, one hop per request.
 *
 * Today the Instagram adapter passes `redirect: "follow"`, so undici resolves
 * the whole chain internally and the adapter sees exactly one call — which is
 * precisely why per-hop validation is impossible without `redirect: "manual"`.
 * This stub models the manual case the approved hardening requires, so the
 * specs for it can be written now and enabled when the adapter changes.
 */
export function stubFetchChain(hops: readonly Hop[]): FetchLog {
  let index = 0;

  return install(() => {
    const hop = hops[index];
    index += 1;

    if (hop === undefined) {
      throw new Error(`The chain has only ${hops.length} hops, but request ${index} was made.`);
    }

    const headers: Record<string, string> =
      hop.location === undefined
        ? { "content-type": "text/html; charset=utf-8" }
        : { location: hop.location };

    return new Response(hop.body ?? "", { status: hop.status, headers });
  });
}
