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

function server(importRecipe = vi.fn(async (): Promise<ImportResult> => result)) {
  return { app: buildServer({ apiKey: API_KEY, importRecipe }), importRecipe };
}

function failingWith(error: unknown) {
  return server(
    vi.fn(async (): Promise<ImportResult> => {
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

describe("authentication is enforced before routing", () => {
  it.each(["/api/import", "/api/imports", "/api/exports/anylist", "/api/does-not-exist"])(
    "answers 401, not 404, for an unauthenticated %s",
    async (url) => {
      // Unauthenticated callers must not be able to enumerate which routes
      // exist. 401 before 404 is what gives that.
      const { app } = server();
      const response = await app.inject({ method: "POST", url, payload: {} });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ success: false, error: "Unauthorized" });
    },
  );

  it("answers 401 for a wrong method on a real route before reporting 404", async () => {
    const { app } = server();

    expect((await app.inject({ method: "GET", url: "/api/import" })).statusCode).toBe(401);
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

    expect(importRecipe).toHaveBeenCalledWith(url);
  });

  it("never runs a dry run: the endpoint always commits to AnyList", async () => {
    // importRecipe is called with the URL alone, so `dryRun` defaults to false.
    // The one-shot endpoint has no way to ask for extraction without a save.
    const { app, importRecipe } = server();
    await app.inject({ method: "POST", url: "/api/import", headers: AUTH, payload: { url: golden.url } });

    expect(importRecipe.mock.calls[0]).toEqual([golden.url]);
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

  it("rejects a text/plain body with 400", async () => {
    // Fastify parses text/plain into a string with its default parser, so this
    // is the Zod schema rejecting a non-object body rather than a media-type
    // refusal.
    const { app } = server();
    const response = await app.inject({
      method: "POST",
      url: "/api/import",
      headers: { ...AUTH, "content-type": "text/plain" },
      payload: "https://www.tiktok.com/@a/video/1",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ success: false, error: "Invalid request body" });
  });

  it.each(["application/xml", "application/x-www-form-urlencoded", "application/octet-stream"])(
    "QA-001: reports the unsupported media type %s as a 500, not the approved 415",
    async (contentType) => {
      // Fastify raises FST_ERR_CTP_INVALID_MEDIA_TYPE with statusCode 415, and
      // the error handler collapses every non-400 status to 500. The approved
      // contract requires `415 Unsupported content type`. Locked as current
      // behaviour; the target is in the specification block at the bottom.
      const { app } = server();
      const response = await app.inject({
        method: "POST",
        url: "/api/import",
        headers: { ...AUTH, "content-type": contentType },
        payload: "<recipe/>",
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ success: false, error: "Recipe import failed" });
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

      expect(importRecipe).toHaveBeenCalledWith(url);
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

  it("QA-001: reports a body over the 8 KB limit as a 500, not the approved 413", async () => {
    // Fastify raises FST_ERR_CTP_BODY_TOO_LARGE with statusCode 413. The error
    // handler maps anything that is not exactly 400 to 500, so an oversized
    // request — entirely the client's doing — is reported as a server failure
    // and logged at error level. The approved contract requires
    // `413 Request body too large`.
    const { app } = server();
    const response = await app.inject({
      method: "POST",
      url: "/api/import",
      headers: AUTH,
      payload: { url: `https://www.tiktok.com/${"a".repeat(9000)}` },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ success: false, error: "Recipe import failed" });
  });
});

describe("the minimum-usable-recipe gate does not cover this endpoint", () => {
  // ADR-019 gates POST /api/imports. POST /api/import is unversioned, remains
  // in the contract for CLI and internal use, and got no such gate — so the
  // QA-003 path is still open on the route that actually ships today.
  const empty = requireRecipe(fixture("instagram-login-blurb"));

  it("returns 200 for an extraction with no ingredients and no instructions", async () => {
    const { app } = server(
      vi.fn(async (): Promise<ImportResult> => ({
        recipe: empty,
        saved: { name: empty.title, identifier: "anylist-junk-id" },
      })),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/import",
      headers: AUTH,
      payload: { url: empty.source.url },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().success).toBe(true);
    expect(response.json().saved.id).toBe("anylist-junk-id");
  });

  it("reports success while returning a confidence of 0.1 and six warnings", async () => {
    const { app } = server(
      vi.fn(async (): Promise<ImportResult> => ({
        recipe: empty,
        saved: { name: empty.title, identifier: "anylist-junk-id" },
      })),
    );
    const body = (await app.inject({
      method: "POST",
      url: "/api/import",
      headers: AUTH,
      payload: { url: empty.source.url },
    })).json();

    expect(body.recipe.confidence).toBe(0.1);
    expect(body.recipe.warnings).toHaveLength(6);
    expect(body.success).toBe(true);
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

  it("returns no X-Request-Id header on any response today", async () => {
    // The approved contract requires a request ID on EVERY response — 200, 400,
    // 401, 404, 409, 413, 415, 422, 500 alike, with no exceptions. Neither the
    // header nor the envelope field exists yet. This test fails the moment they
    // land, which is the point: it forces the specifications to be unskipped.
    const { app } = server();

    const success = await app.inject({ method: "POST", url: "/api/import", headers: AUTH, payload: { url: golden.url } });
    const failure = await app.inject({ method: "POST", url: "/api/import", payload: {} });

    expect(success.headers["x-request-id"]).toBeUndefined();
    expect(failure.headers["x-request-id"]).toBeUndefined();
    expect(success.json().requestId).toBeUndefined();
    expect(failure.json().requestId).toBeUndefined();
  });

  it("does not adopt a client-supplied X-Request-Id today", async () => {
    const { app } = server();
    const response = await app.inject({
      method: "POST",
      url: "/api/import",
      headers: { ...AUTH, "x-request-id": "client-supplied-id" },
      payload: { url: golden.url },
    });

    expect(response.headers["x-request-id"]).toBeUndefined();
    expect(response.body).not.toContain("client-supplied-id");
  });
});

/**
 * ENABLE when the approved HTTP error contract lands (contracts.md "HTTP error
 * contract"). Change `describe.skip` to `describe` and delete the QA-001 locks
 * and the "no X-Request-Id today" tests above.
 *
 * These apply to POST /api/import as well as the new routes: the approved
 * request-ID rule says "every response ... with no exceptions".
 */
describe.skip("approved HTTP error contract — specification", () => {
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
  ] as const)("sets X-Request-Id on a %s response", async (_label, options) => {
    // "Every response carries a request ID — 200, 400, 401, 404, 409, 413, 415,
    // 422, and 500 alike, with no exceptions."
    const { app } = server();
    const response = await app.inject({
      method: "POST",
      url: options.url,
      ...(options.auth ? { headers: AUTH } : {}),
      payload: options.payload,
    });

    expect(response.headers["x-request-id"]).toBeTruthy();
    expect(response.json().requestId).toBe(response.headers["x-request-id"]);
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
