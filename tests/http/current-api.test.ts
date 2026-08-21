import { describe, expect, it, vi } from "vitest";

import { FAILING_FIXTURES, fixture } from "../../fixtures/corpus.js";
import { requireRecipe } from "../../fixtures/types.js";
import { ImportError, type ImportResult } from "../../src/app/import-service.js";
import { buildServer } from "../../src/http/server.js";

/**
 * Regression lock on the API as it exists today, ahead of the extraction/export
 * split. Everything the iOS client and the Shortcut will depend on is pinned
 * here so the split cannot quietly change it.
 *
 * importRecipe is always injected, so nothing here reaches TikTok, Instagram,
 * Anthropic, or AnyList.
 */

const API_KEY = "test-api-key-2f8c1d";
const AUTH = { authorization: `Bearer ${API_KEY}` };

const golden = fixture("tiktok-cottage-cheese-brownies");
const recipe = requireRecipe(golden);

const result: ImportResult = {
  recipe,
  saved: { name: recipe.title, identifier: "anylist-recipe-id-42" },
};

function server(
  importRecipe = vi.fn(async (_url: string, _options?: unknown): Promise<ImportResult> => result),
) {
  return { app: buildServer({ apiKey: API_KEY, importRecipe }), importRecipe };
}

function failingWith(error: unknown) {
  return server(
    vi.fn(async (_url: string, _options?: unknown): Promise<ImportResult> => {
      throw error;
    }),
  );
}

describe("GET /health", () => {
  it("stays unauthenticated even when a wrong token is supplied", async () => {
    const { app, importRecipe } = server();
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { authorization: "Bearer definitely-wrong" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(importRecipe).not.toHaveBeenCalled();
  });

  it("answers a HEAD request without a body", async () => {
    const { app } = server();
    const response = await app.inject({ method: "HEAD", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("");
  });

  it("ignores a query string", async () => {
    const { app } = server();

    expect((await app.inject({ method: "GET", url: "/health?probe=1" })).statusCode).toBe(200);
  });
});

describe("authentication is deny-by-default over every registered route", () => {
  it.each(["/api/import", "/api/imports", "/api/exports/anylist"])(
    "answers 401 for an unauthenticated %s",
    async (url) => {
      const { app } = server();
      const response = await app.inject({ method: "POST", url, payload: {} });

      expect(response.statusCode).toBe(401);
      expect(response.json().error).toBe("Unauthorized");
    },
  );

  it("carries requestId in the 401 envelope on the production routes", async () => {
    const { app } = server();

    for (const url of ["/api/imports", "/api/exports/anylist"]) {
      const response = await app.inject({ method: "POST", url, payload: {} });

      expect(response.json().requestId).toBe(response.headers["x-request-id"]);
    }
  });

  it("keeps the Part 1 envelope byte-for-byte on POST /api/import", async () => {
    // The frozen Part 1 shape: no requestId in the body. The header is still
    // set, which is additive and cannot break a client that does not read it.
    // See the report — whether "requestId wherever an envelope is returned"
    // was meant to reach this route is a contract question, not a defect.
    const { app } = server();
    const response = await app.inject({ method: "POST", url: "/api/import", payload: {} });

    expect(response.json()).toEqual({ success: false, error: "Unauthorized" });
    expect(response.headers["x-request-id"]).toBeTruthy();
  });

  it("answers 404, not 401, for a path no route is registered at", async () => {
    // Deliberate: authentication is applied over *registered* routes, so an
    // unmatched path falls to the not-found handler and answers `404 Not found`
    // exactly as Part 1 freezes it.
    //
    // Consequence worth knowing: an unauthenticated caller can tell a
    // registered route (401) from an unregistered one (404). The route set is
    // public in contracts.md, so this discloses nothing secret — recorded as an
    // observation, not a finding.
    const { app } = server();
    const response = await app.inject({ method: "POST", url: "/api/does-not-exist", payload: {} });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("Not found");
  });

  it("answers 404 for a wrong method on a real route", async () => {
    const { app } = server();

    expect((await app.inject({ method: "GET", url: "/api/import" })).statusCode).toBe(404);
  });

  it("never reaches the pipeline for an unauthenticated request", async () => {
    const { app, importRecipe } = server();
    await app.inject({ method: "POST", url: "/api/import", payload: { url: golden.url } });

    expect(importRecipe).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown /api route once authenticated", async () => {
    const { app } = server();
    const response = await app.inject({ method: "POST", url: "/api/nope", headers: AUTH, payload: {} });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ success: false, error: "Not found" });
  });

  it("accepts the Authorization header whatever its name is cased as", async () => {
    const { app } = server();
    const response = await app.inject({
      method: "POST",
      url: "/api/import",
      headers: { AUTHORIZATION: `Bearer ${API_KEY}` },
      payload: { url: golden.url },
    });

    expect(response.statusCode).toBe(200);
  });

  it("does not route /api/import/ with a trailing slash", async () => {
    const { app, importRecipe } = server();
    const response = await app.inject({
      method: "POST",
      url: "/api/import/",
      headers: AUTH,
      payload: { url: golden.url },
    });

    expect(response.statusCode).toBe(404);
    expect(importRecipe).not.toHaveBeenCalled();
  });
});

describe("POST /api/import — request handling", () => {
  it("returns only title, confidence, and warnings, never the whole Recipe", async () => {
    const { app } = server();
    const body = (await app.inject({ method: "POST", url: "/api/import", headers: AUTH, payload: { url: golden.url } })).json();

    expect(Object.keys(body).sort()).toEqual(["recipe", "saved", "success"]);
    expect(Object.keys(body.recipe).sort()).toEqual(["confidence", "title", "warnings"]);
    expect(Object.keys(body.saved)).toEqual(["id"]);
  });

  it("passes the submitted URL through untouched", async () => {
    const { app, importRecipe } = server();
    const url = "https://www.tiktok.com/@a/video/1?is_from_webapp=1&sender_device=pc";
    await app.inject({ method: "POST", url: "/api/import", headers: AUTH, payload: { url } });

    expect(importRecipe.mock.calls[0]?.[0]).toBe(url);
  });

  it("never runs a dry run: the endpoint always commits to AnyList", async () => {
    // The route now passes an options object carrying an `onSourceContent`
    // telemetry callback. That is additive: what matters for this contract is
    // that `dryRun` is never set, so the one-shot endpoint cannot be talked
    // into extracting without saving.
    const { app, importRecipe } = server();
    await app.inject({ method: "POST", url: "/api/import", headers: AUTH, payload: { url: golden.url } });

    const options = importRecipe.mock.calls[0]?.[1] as { dryRun?: boolean } | undefined;
    expect(options?.dryRun).toBeUndefined();
  });

  it("passes only a telemetry callback alongside the URL", async () => {
    // Pins the shape of the addition, so a future option that changes what the
    // endpoint does cannot be added without this test noticing.
    const { app, importRecipe } = server();
    await app.inject({ method: "POST", url: "/api/import", headers: AUTH, payload: { url: golden.url } });

    const options = importRecipe.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(Object.keys(options ?? {})).toEqual(["onSourceContent"]);
  });

  it("ignores a query string on the route", async () => {
    const { app } = server();
    const response = await app.inject({
      method: "POST",
      url: "/api/import?trace=1",
      headers: AUTH,
      payload: { url: golden.url },
    });

    expect(response.statusCode).toBe(200);
  });

  it.each([
    ["a missing body", undefined],
    ["a JSON null body", "null"],
    ["an array body", "[1,2]"],
    ["malformed JSON", "{not json"],
    ["a bare string", '"https://www.tiktok.com/@a/video/1"'],
  ])("rejects %s with the standard 400 envelope", async (_label, raw) => {
    const { app, importRecipe } = server();
    const response = await app.inject({
      method: "POST",
      url: "/api/import",
      headers: { ...AUTH, "content-type": "application/json" },
      ...(raw === undefined ? {} : { payload: raw }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ success: false, error: "Invalid request body" });
    expect(importRecipe).not.toHaveBeenCalled();
  });

  it("rejects a text/plain body with 415, not a confusing 400", async () => {
    // The default text/plain parser is removed, so a wrong content type is an
    // honest media-type refusal rather than a complaint about the body shape.
    const { app } = server();
    const response = await app.inject({
      method: "POST",
      url: "/api/import",
      headers: { ...AUTH, "content-type": "text/plain" },
      payload: "https://www.tiktok.com/@a/video/1",
    });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toEqual({ success: false, error: "Unsupported content type" });
  });

  it.each(["application/xml", "application/x-www-form-urlencoded", "application/octet-stream"])(
    "QA-001 RESOLVED: reports the unsupported media type %s as 415",
    async (contentType) => {
      const { app } = server();
      const response = await app.inject({
        method: "POST",
        url: "/api/import",
        headers: { ...AUTH, "content-type": contentType },
        payload: "<recipe/>",
      });

      expect(response.statusCode).toBe(415);
      expect(response.json()).toEqual({ success: false, error: "Unsupported content type" });
    },
  );

  it.each([
    ["a bare hostname", "www.tiktok.com/@a/video/1"],
    ["an empty string", ""],
    ["a sentence", "please import my recipe"],
  ])("rejects %s at the body schema, before the pipeline runs", async (_label, url) => {
    const { app, importRecipe } = server();
    const response = await app.inject({ method: "POST", url: "/api/import", headers: AUTH, payload: { url } });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ success: false, error: "Invalid request body" });
    expect(importRecipe).not.toHaveBeenCalled();
  });

  it.each(["file:///etc/passwd", "javascript:alert(1)", "data:text/plain,x"])(
    "passes %s through the body schema and leaves the scheme check to the pipeline",
    async (url) => {
      // z.string().url() accepts any parseable URL. The http(s) check lives in
      // detectPlatform, inside the import service. So the endpoint's own
      // validation does NOT stop a non-http scheme — the pipeline does, and
      // tests/failure-modes/pipeline-failures.test.ts proves it end to end.
      const { app, importRecipe } = server();
      await app.inject({ method: "POST", url: "/api/import", headers: AUTH, payload: { url } });

      expect(importRecipe.mock.calls[0]?.[0]).toBe(url);
    },
  );

  it("accepts a body just under the 8 KB limit", async () => {
    const { app } = server();
    const response = await app.inject({
      method: "POST",
      url: "/api/import",
      headers: AUTH,
      payload: { url: `https://www.tiktok.com/${"a".repeat(7000)}` },
    });

    expect(response.statusCode).toBe(200);
  });

  it("QA-001 RESOLVED: reports a body over the 8 KB limit as 413", async () => {
    const { app } = server();
    const response = await app.inject({
      method: "POST",
      url: "/api/import",
      headers: AUTH,
      payload: { url: `https://www.tiktok.com/${"a".repeat(9000)}` },
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({ success: false, error: "Request body too large" });
  });
});

describe("failure mapping across the golden corpus", () => {
  it.each(FAILING_FIXTURES.map((f) => [f.id, f] as const))(
    "%s maps to its documented status and error string",
    async (_id, entry) => {
      const failure = entry.expectedFailure;
      if (failure === null) throw new Error("unreachable");

      const { app } = failingWith(new ImportError("internal detail that must not escape", failure.importKind));
      const response = await app.inject({
        method: "POST",
        url: "/api/import",
        headers: AUTH,
        payload: { url: entry.url },
      });

      expect(response.statusCode).toBe(failure.httpStatus);
      expect(response.json()).toEqual({ success: false, error: failure.httpError });
    },
  );
});

describe("the error envelope is uniform", () => {
  const cases: ReadonlyArray<readonly [string, () => ReturnType<typeof server>, object]> = [
    ["401", () => server(), {}],
    ["400", () => server(), { payload: { nope: 1 } }],
    ["404", () => server(), {}],
    ["422", () => failingWith(new ImportError("x", "extraction_failed")), {}],
    ["500", () => failingWith(new ImportError("x", "save_failed")), {}],
  ];

  it.each(cases.map(([label]) => label))("a %s body has exactly success and error", async (label) => {
    const entry = cases.find(([name]) => name === label);
    if (entry === undefined) throw new Error("unreachable");
    const [, make, options] = entry;

    const { app } = make();
    const response = await app.inject({
      method: "POST",
      url: label === "404" ? "/api/unknown" : "/api/import",
      ...(label === "401" ? {} : { headers: AUTH }),
      payload: { url: golden.url },
      ...options,
    });

    const body = response.json();
    expect(Object.keys(body).sort()).toEqual(["error", "success"]);
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe("string");
  });

  it("sets X-Request-Id on every response, success and failure alike", async () => {
    const { app } = server();

    const success = await app.inject({ method: "POST", url: "/api/import", headers: AUTH, payload: { url: golden.url } });
    const failure = await app.inject({ method: "POST", url: "/api/import", payload: {} });
    const notFound = await app.inject({ method: "GET", url: "/nope" });
    const health = await app.inject({ method: "GET", url: "/health" });

    for (const response of [success, failure, notFound, health]) {
      expect(response.headers["x-request-id"]).toBeTruthy();
    }
  });

  it("adopts a client-supplied X-Request-Id", async () => {
    const { app } = server();
    const response = await app.inject({
      method: "POST",
      url: "/api/import",
      headers: { ...AUTH, "x-request-id": "client-supplied-id" },
      payload: { url: golden.url },
    });

    expect(response.headers["x-request-id"]).toBe("client-supplied-id");
  });
});

/**
 * The approved HTTP error contract. Implemented and activated 2026-08-21.
 */
describe("approved HTTP error contract", () => {
  it("returns 413 Request body too large for an oversized body", async () => {
    const { app } = server();
    const response = await app.inject({
      method: "POST",
      url: "/api/import",
      headers: AUTH,
      payload: { url: `https://www.tiktok.com/${"a".repeat(9000)}` },
    });

    expect(response.statusCode).toBe(413);
    expect(response.json().error).toBe("Request body too large");
  });

  it.each(["application/xml", "application/x-www-form-urlencoded", "application/octet-stream"])(
    "returns 415 Unsupported content type for %s",
    async (contentType) => {
      const { app } = server();
      const response = await app.inject({
        method: "POST",
        url: "/api/import",
        headers: { ...AUTH, "content-type": contentType },
        payload: "<recipe/>",
      });

      expect(response.statusCode).toBe(415);
      expect(response.json().error).toBe("Unsupported content type");
    },
  );

  it("keeps the 8 KB limit on POST /api/import", async () => {
    const { app } = server();
    const ok = await app.inject({
      method: "POST",
      url: "/api/import",
      headers: AUTH,
      payload: { url: `https://www.tiktok.com/${"a".repeat(7000)}` },
    });

    expect(ok.statusCode).toBe(200);
  });

  it("sets X-Request-Id on a successful response", async () => {
    const { app } = server();
    const response = await app.inject({
      method: "POST",
      url: "/api/import",
      headers: AUTH,
      payload: { url: golden.url },
    });

    expect(response.headers["x-request-id"]).toBeTruthy();
  });

  it.each([
    ["401", { url: "/api/import", auth: false, payload: { url: golden.url } }],
    ["400", { url: "/api/import", auth: true, payload: { nope: 1 } }],
    ["404", { url: "/api/unknown", auth: true, payload: {} }],
    ["413", { url: "/api/import", auth: true, payload: { url: `https://x.co/${"a".repeat(9000)}` } }],
  ] as const)("sets X-Request-Id on a %s response", async (_label, options) => {
    // "Every response carries a request ID — 200, 400, 401, 404, 409, 413, 415,
    // 422, and 500 alike, with no exceptions." The header is universal.
    const { app } = server();
    const response = await app.inject({
      method: "POST",
      url: options.url,
      ...(options.auth ? { headers: AUTH } : {}),
      payload: options.payload,
    });

    expect(response.headers["x-request-id"]).toBeTruthy();
  });

  it("puts requestId in the envelope on the production routes", async () => {
    const { app } = server();
    const response = await app.inject({ method: "POST", url: "/api/imports", payload: {} });

    expect(response.json().requestId).toBe(response.headers["x-request-id"]);
  });

  it("leaves requestId out of the frozen Part 1 envelopes", async () => {
    // POST /api/import and the not-found handler keep their Part 1 bodies
    // byte-for-byte. Whether the approved "requestId wherever an envelope is
    // returned" was meant to reach them is a contract question — see the
    // report. The header is present on both regardless.
    const { app } = server();

    const legacy = await app.inject({ method: "POST", url: "/api/import", payload: {} });
    const notFound = await app.inject({ method: "GET", url: "/nope" });

    expect(legacy.json().requestId).toBeUndefined();
    expect(notFound.json().requestId).toBeUndefined();
    expect(legacy.headers["x-request-id"]).toBeTruthy();
    expect(notFound.headers["x-request-id"]).toBeTruthy();
  });

  it("sets X-Request-Id on GET /health", async () => {
    // /health returns no envelope, so only the header applies. "No exceptions"
    // is read literally here; if /health is meant to be exempt, the contract
    // needs to say so.
    const { app } = server();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.headers["x-request-id"]).toBeTruthy();
  });

  it("adopts a client-supplied X-Request-Id rather than replacing it", async () => {
    const { app } = server();
    const response = await app.inject({
      method: "POST",
      url: "/api/import",
      headers: { ...AUTH, "x-request-id": "shortcut-run-42" },
      payload: { url: golden.url },
    });

    expect(response.headers["x-request-id"]).toBe("shortcut-run-42");
  });

  it("keeps the request id out of the redaction surface", async () => {
    // A client-supplied id is untrusted input that is echoed back. It must not
    // become a way to smuggle content into a response or a log line.
    const { app } = server();
    const response = await app.inject({
      method: "POST",
      url: "/api/import",
      headers: { ...AUTH, "x-request-id": "<script>alert(1)</script>" },
      payload: { url: golden.url },
    });

    expect(response.headers["x-request-id"]).not.toContain("<script>");
  });
});
