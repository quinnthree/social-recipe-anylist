/**
 * Child process for tests/http/logging-redaction.test.ts.
 *
 * buildServer only accepts `logger: boolean`, so the real pino instance cannot
 * be handed a capture stream from inside a test (see docs/qa/findings.md
 * QA-010). Running the server in a child process and reading its stdout is the
 * way to observe what production logging actually emits without changing
 * production source.
 *
 * `app.inject()` is used rather than `listen()`, so no port is ever opened.
 *
 * Everything this file prints on stdout is pino output. It must not console.log.
 */
import { ImportError, type ImportResult } from "../../src/app/import-service.js";
import { buildServer } from "../../src/http/server.js";
import type { Recipe } from "../../src/recipe/schema.js";
import { SECRETS } from "./planted-secrets.js";


const recipe: Recipe = {
  title: "Cottage Cheese Brownies",
  description: null,
  servings: 9,
  prepTime: null,
  cookTime: { minMinutes: 35, maxMinutes: 40 },
  ingredients: [
    { quantity: "16", unit: "oz", name: "cottage cheese", preparation: null, rawText: "16 oz cottage cheese" },
  ],
  instructions: ["Blend until smooth."],
  source: {
    platform: "tiktok",
    creator: "proteinbakes",
    url: "https://www.tiktok.com/@proteinbakes/video/7311111111111111111",
  },
  confidence: 0.9,
  warnings: ["No servings were stated in the source text."],
};

/**
 * A provider error shaped the way a real one is: the credentials are reachable
 * from the message, the stack, and nested request/response detail.
 */
function credentialBearingError(): Error {
  return Object.assign(
    new ImportError(
      `AnyList login failed for ${SECRETS.anylistEmail} with password ${SECRETS.anylistPassword}`,
      "save_failed",
    ),
    {
      response: {
        statusCode: 401,
        body: `{"token":"${SECRETS.anylistToken}"}`,
        request: { headers: { authorization: `Bearer ${SECRETS.anthropicKey}` } },
      },
    },
  );
}

let failNext = false;

async function runImport(): Promise<ImportResult> {
  if (failNext) throw credentialBearingError();
  return { recipe, saved: { name: recipe.title, identifier: "anylist-recipe-id-42" } };
}

const app = buildServer({ apiKey: SECRETS.apiKey, importRecipe: runImport, logger: true });

const url = "https://www.tiktok.com/@proteinbakes/video/7311111111111111111";
const authorized = { authorization: `Bearer ${SECRETS.apiKey}` };

// 1. Unauthenticated health check.
await app.inject({ method: "GET", url: "/health" });

// 2. A successful, authenticated import.
await app.inject({ method: "POST", url: "/api/import", headers: authorized, payload: { url } });

// 3. A rejected request carrying a wrong-but-secret-shaped bearer token.
await app.inject({
  method: "POST",
  url: "/api/import",
  headers: { authorization: `Bearer ${SECRETS.anthropicKey}` },
  payload: { url },
});

// 4. A malformed body from an authenticated caller.
await app.inject({ method: "POST", url: "/api/import", headers: authorized, payload: { nope: true } });

// 5. An import that fails with a credential-bearing provider error.
failNext = true;
await app.inject({ method: "POST", url: "/api/import", headers: authorized, payload: { url } });

// 6. An unknown route.
await app.inject({ method: "GET", url: "/api/unknown", headers: authorized });

await app.close();
