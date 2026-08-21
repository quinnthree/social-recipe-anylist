import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { ImportError } from "../../app/import-service.js";
import {
  bearer,
  sourceContent,
  TEST_API_KEY,
  TEST_URL,
  validRecipe,
} from "../../test-support/fixtures.js";
import { buildServer } from "../server.js";

const REQUEST_ID = /^req_[0-9A-HJKMNP-TV-Z]{26}$/;

function server(
  extract: (...args: never[]) => Promise<typeof validRecipe> = async () => validRecipe,
): { app: FastifyInstance; extract: typeof extract } {
  const extractRecipe = vi.fn(extract) as never;
  return {
    app: buildServer({ apiKey: TEST_API_KEY, extractRecipe }),
    extract: extractRecipe,
  };
}

function post(
  app: FastifyInstance,
  options: { auth?: string; payload?: unknown; headers?: Record<string, string> } = {},
) {
  return app.inject({
    method: "POST",
    url: "/api/imports",
    headers: {
      "content-type": "application/json",
      ...(options.auth === undefined ? {} : { authorization: options.auth }),
      ...options.headers,
    },
    payload: options.payload ?? { schemaVersion: 1, url: TEST_URL },
  });
}

describe("POST /api/imports", () => {
  describe("success", () => {
    it("returns the complete canonical Recipe, not a summary", async () => {
      const { app } = server();
      const response = await post(app, { auth: bearer() });

      expect(response.statusCode).toBe(200);
      // The client needs every field to render the review screen. A subset
      // would silently make the edit step impossible.
      expect(response.json().recipe).toEqual(validRecipe);
    });

    it("carries schemaVersion and requestId", async () => {
      const { app } = server();
      const body = (await post(app, { auth: bearer() })).json();

      expect(body.schemaVersion).toBe(1);
      expect(body.requestId).toMatch(REQUEST_ID);
      expect(body.success).toBe(true);
    });

    it("never reaches the export path", async () => {
      const exportRecipe = vi.fn();
      const app = buildServer({
        apiKey: TEST_API_KEY,
        extractRecipe: (async () => validRecipe) as never,
        exportRecipe: exportRecipe as never,
      });

      const response = await post(app, { auth: bearer() });

      // The contract's central promise: extraction writes nothing to AnyList.
      expect(response.statusCode).toBe(200);
      expect(exportRecipe).not.toHaveBeenCalled();
    });

    it("passes the submitted URL through", async () => {
      const { app, extract } = server();
      await post(app, { auth: bearer() });

      expect(extract).toHaveBeenCalledWith(TEST_URL, expect.any(Object));
    });
  });

  describe("schemaVersion", () => {
    it.each([
      ["missing", { url: TEST_URL }],
      ["a string", { schemaVersion: "1", url: TEST_URL }],
      ["fractional", { schemaVersion: 1.5, url: TEST_URL }],
      ["null", { schemaVersion: null, url: TEST_URL }],
    ])("rejects %s as an invalid body", async (_label, payload) => {
      const { app } = server();
      const response = await post(app, { auth: bearer(), payload });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("Invalid request body");
    });

    it("names an unsupported version rather than calling it malformed", async () => {
      const { app } = server();
      const response = await post(app, {
        auth: bearer(),
        payload: { schemaVersion: 2, url: TEST_URL },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("Unsupported schema version");
    });
  });

  describe("strict validation", () => {
    it("rejects an unknown key", async () => {
      const { app, extract } = server();
      const response = await post(app, {
        auth: bearer(),
        payload: { schemaVersion: 1, url: TEST_URL, notes: "hi" },
      });

      expect(response.statusCode).toBe(400);
      expect(extract).not.toHaveBeenCalled();
    });

    it("rejects a malformed URL before any expensive work", async () => {
      const { app, extract } = server();
      const response = await post(app, {
        auth: bearer(),
        payload: { schemaVersion: 1, url: "not-a-url" },
      });

      expect(response.statusCode).toBe(400);
      expect(extract).not.toHaveBeenCalled();
    });
  });

  describe("failure mapping", () => {
    it.each([
      ["invalid_url", 400, "Invalid recipe URL"],
      ["unsupported_platform", 400, "Unsupported platform"],
      ["extraction_failed", 422, "Recipe could not be extracted"],
      ["internal", 500, "Recipe import failed"],
    ] as const)("maps %s to %i", async (kind, status, message) => {
      const { app } = server(async () => {
        throw new ImportError("underlying detail that must not escape", kind);
      });
      const response = await post(app, { auth: bearer() });

      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({
        success: false,
        error: message,
        requestId: expect.stringMatching(REQUEST_ID),
      });
    });

    it("returns 422 when the recipe is unusable, not a 200 with an empty recipe", async () => {
      const { app } = server(async () => {
        throw new ImportError("not usable", "extraction_failed");
      });

      expect((await post(app, { auth: bearer() })).statusCode).toBe(422);
    });

    it("never echoes the underlying message", async () => {
      const { app } = server(async () => {
        throw new Error("ANYLIST_PASSWORD=hunter2 leaked into an error");
      });
      const response = await post(app, { auth: bearer() });

      expect(response.body).not.toContain("hunter2");
      expect(response.body).not.toContain("ANYLIST_PASSWORD");
    });
  });

  describe("auth", () => {
    it("rejects a missing token", async () => {
      const { app, extract } = server();
      const response = await post(app);

      expect(response.statusCode).toBe(401);
      expect(response.json().error).toBe("Unauthorized");
      expect(extract).not.toHaveBeenCalled();
    });

    it("rejects a wrong token", async () => {
      const { app } = server();

      expect((await post(app, { auth: bearer("wrong-key") })).statusCode).toBe(401);
    });

    it("includes requestId on the 401 envelope for this route", async () => {
      const { app } = server();

      expect((await post(app)).json().requestId).toMatch(REQUEST_ID);
    });
  });

  describe("idempotency", () => {
    it("is not required, because extraction writes nothing", async () => {
      const { app } = server();

      expect((await post(app, { auth: bearer() })).statusCode).toBe(200);
    });

    it("runs again on a repeated key rather than replaying", async () => {
      const { app, extract } = server();
      const headers = { "idempotency-key": "same-key" };

      await post(app, { auth: bearer(), headers });
      await post(app, { auth: bearer(), headers });

      expect(extract).toHaveBeenCalledTimes(2);
    });
  });
});
