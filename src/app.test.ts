import {
  createServer as createHttpServer,
  get,
  request as httpRequest,
  type IncomingMessage,
  type Server,
} from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The Vercel entrypoint contract, exercised rather than asserted about.
 *
 * The deployed launcher imports this module, unwraps `default`, and — when it
 * is a function — uses it directly as the Lambda's `(req, res)` handler. These
 * tests stand a real `http.Server` on that same function, so a change that
 * would produce "Invalid export found in module ... The default export must be
 * a function or server" fails here first.
 */

// buildServer refuses to start without this, and the module builds at import.
process.env["RECIPE_API_KEY"] ??= "app-entrypoint-test-key";

const entrypoint = await import("./app.js");

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createHttpServer((request, response) => {
    void entrypoint.default(request, response);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function fetchPath(path: string): Promise<{ status: number; body: string; requestId?: string }> {
  return new Promise((resolve, reject) => {
    get(`${origin}${path}`, (response: IncomingMessage) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          body,
          ...(typeof response.headers["x-request-id"] === "string"
            ? { requestId: response.headers["x-request-id"] }
            : {}),
        }),
      );
    }).on("error", reject);
  });
}

function postPath(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outbound = httpRequest(
      `${origin}${path}`,
      { method: "POST", headers: { "content-type": "application/json" } },
      (response: IncomingMessage) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    outbound.on("error", reject);
    outbound.end(JSON.stringify({ schemaVersion: 1, url: "https://www.tiktok.com/@a/video/1" }));
  });
}

describe("the Vercel default export", () => {
  it("is a function, which is the shape the launcher accepts", () => {
    // "The default export must be a function or server." A named export, or a
    // Promise, is not enough — the launcher unwraps `default` and type-checks it.
    expect(typeof entrypoint.default).toBe("function");
  });

  it("serves GET /health through the real router", async () => {
    const response = await fetchPath("/health");

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: "ok" });
  });

  it("runs the full hook chain, not just route matching", async () => {
    // If routing() were bypassing hooks, X-Request-Id would be absent.
    const response = await fetchPath("/health");

    expect(response.requestId).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("keeps authentication in force on a real production route", async () => {
    const response = await postPath("/api/imports");

    expect(response.status).toBe(401);
    expect(JSON.parse(response.body).error).toBe("Unauthorized");
  });

  it("still answers unknown routes with the frozen envelope", async () => {
    const response = await fetchPath("/nope");

    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toEqual({ success: false, error: "Not found" });
  });

  it("exposes maxDuration as a statically parseable literal", () => {
    expect(entrypoint.config).toEqual({ maxDuration: 120 });
  });
});

describe("importing the Vercel entrypoint", () => {
  it("opens no listener of its own", () => {
    // The only listener in this test is the one it created above. If app.ts
    // listened too, Vercel's launcher patch would swallow that call and the
    // Fastify promise would never settle.
    const source = readFileSync("src/app.ts", "utf8");

    expect(source).not.toMatch(/\.listen\s*\(/);
    expect(source).not.toContain('from "./server.js"');
  });

  it("leaves listening to the local entrypoint alone", () => {
    const local = readFileSync("src/server.ts", "utf8");
    const occurrences = local.match(/\.listen\s*\(/g) ?? [];

    expect(occurrences).toHaveLength(1);
  });
});
