import { afterEach, describe, expect, it, vi } from "vitest";

import { fixture } from "../../fixtures/corpus.js";
import { requireRecipe } from "../../fixtures/types.js";
import { AnyListRecipeSaver, type AnyListClientLike } from "../../src/anylist/client.js";
import type { CreateRecipeOptions, RecipeSaver } from "../../src/anylist/types.js";
import { ImportError, importRecipe, type ImportDeps } from "../../src/app/import-service.js";
import { parseRecipe } from "../../src/recipe/parser.js";
import { fetchSourceContent } from "../../src/social/index.js";
import { stubFetchFor, stubFetchRejection, stubFetchResponse } from "../support/fetch-stub.js";

/**
 * Every failure mode the production API has to classify, driven deterministically.
 *
 * The recurring assertion is *how many times the external write was attempted*.
 * ADR-012 forbids automatically retrying createRecipe after an ambiguous
 * outcome, and the cheapest way to keep that true is to prove that today
 * nothing retries it at all.
 */

const golden = fixture("tiktok-cottage-cheese-brownies");
const recipe = requireRecipe(golden);

const neverCalled = {
  fetchSourceContent: (): never => {
    throw new Error("fetchSourceContent should not have been called.");
  },
  parseRecipe: (): never => {
    throw new Error("parseRecipe should not have been called.");
  },
};

function deps(overrides: Partial<ImportDeps> = {}): ImportDeps {
  return {
    fetchSourceContent,
    parseRecipe,
    createSaver: () => {
      throw new Error("createSaver should not have been called.");
    },
    ...overrides,
  };
}

async function kindOf(url: string, overrides: Partial<ImportDeps> = {}): Promise<string> {
  const error = await importRecipe(url, { deps: deps(overrides) }).catch((thrown: unknown) => thrown);

  expect(error).toBeInstanceOf(ImportError);
  return (error as ImportError).kind;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("source fetch failures", () => {
  it.each([500, 502, 503, 429, 404])(
    "classifies HTTP %i from TikTok's oEmbed endpoint as extraction_failed",
    async (status) => {
      const log = stubFetchResponse(status, "");

      expect(await kindOf(golden.url)).toBe("extraction_failed");
      // Retryable at the transport level, but nothing here retries. A client
      // that retries pays for a whole new request; the server never does.
      expect(log.urls).toHaveLength(1);
    },
  );

  it.each([
    ["a reset connection", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })],
    ["a DNS failure", Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" })],
    ["a timeout", Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" })],
  ])("classifies %s as extraction_failed without retrying", async (_label, error) => {
    const log = stubFetchRejection(error);

    expect(await kindOf(golden.url)).toBe("extraction_failed");
    expect(log.urls).toHaveLength(1);
  });

  it("classifies a non-JSON oEmbed body as extraction_failed", async () => {
    stubFetchResponse(200, "<html>rate limited</html>");

    expect(await kindOf(golden.url)).toBe("extraction_failed");
  });

  it("classifies an oEmbed response with no caption as extraction_failed", async () => {
    stubFetchResponse(200, JSON.stringify({ author_name: "someone", title: "   " }));

    expect(await kindOf(golden.url)).toBe("extraction_failed");
  });

  it("classifies the Instagram login wall as extraction_failed, not as a bad URL", async () => {
    const wall = fixture("instagram-login-wall");
    stubFetchFor(wall);

    expect(await kindOf(wall.url)).toBe("extraction_failed");
  });

  it("classifies an Instagram HTTP error as extraction_failed", async () => {
    stubFetchResponse(401, "");

    expect(await kindOf("https://www.instagram.com/reel/Cxyz123/")).toBe("extraction_failed");
  });

  it.each(["file:///etc/passwd", "javascript:alert(1)", "data:text/plain,x"])(
    "rejects %s as invalid_url, with no request made",
    async (url) => {
      // Closes the loop left open at the HTTP layer: the body schema accepts
      // these, and this is where they are actually stopped.
      const log = stubFetchRejection(new Error("must not be reached"));

      expect(await kindOf(url)).toBe("invalid_url");
      expect(log.urls).toEqual([]);
    },
  );

  it("rejects an unsupported host as unsupported_platform, with no request made", async () => {
    const log = stubFetchRejection(new Error("must not be reached"));

    expect(await kindOf(fixture("unsupported-url-pinterest").url)).toBe("unsupported_platform");
    expect(await kindOf(fixture("youtube-canonical-not-ingestible").url)).toBe("unsupported_platform");
    expect(log.urls).toEqual([]);
  });
});

describe("extraction (Anthropic) failures", () => {
  const transient = [
    ["a 429 overload", Object.assign(new Error("rate_limit_error"), { status: 429 })],
    ["a 529 overload", Object.assign(new Error("overloaded_error"), { status: 529 })],
    ["a connection error", Object.assign(new Error("Connection error."), { status: undefined })],
    ["an unparseable response", new Error("The model did not return a parseable recipe")],
  ] as const;

  it.each(transient)("classifies %s as extraction_failed", async (_label, error) => {
    const kind = await kindOf(golden.url, {
      ...neverCalled,
      fetchSourceContent: async () => {
        if (golden.expectedSourceContent === null) throw new Error("unreachable");
        return golden.expectedSourceContent;
      },
      parseRecipe: async () => {
        throw error;
      },
    });

    expect(kind).toBe("extraction_failed");
  });

  it("never constructs the AnyList saver when extraction fails", async () => {
    const createSaver = vi.fn((): RecipeSaver => {
      throw new Error("must not be reached");
    });
    stubFetchResponse(500, "");

    await importRecipe(golden.url, { deps: deps({ createSaver }) }).catch(() => undefined);

    expect(createSaver).not.toHaveBeenCalled();
  });

  it("never contacts AnyList on a dry run", async () => {
    const createSaver = vi.fn((): RecipeSaver => {
      throw new Error("must not be reached");
    });
    stubFetchFor(golden);

    const result = await importRecipe(golden.url, {
      dryRun: true,
      deps: deps({ createSaver, parseRecipe: async () => recipe }),
    });

    expect(result.saved).toBeNull();
    expect(createSaver).not.toHaveBeenCalled();
  });
});

describe("AnyList export failures", () => {
  interface Calls {
    login: number;
    create: number;
    verify: number;
  }

  interface FakeOptions {
    loginError?: unknown;
    createError?: unknown;
    verifyError?: unknown;
    verifyResult?: { id: string } | null;
  }

  function saverWith(options: FakeOptions): { saver: RecipeSaver; calls: Calls } {
    const calls: Calls = { login: 0, create: 0, verify: 0 };

    const client: AnyListClientLike = {
      async createRecipe(payload: CreateRecipeOptions) {
        calls.create += 1;
        if (options.createError !== undefined) throw options.createError;
        return { id: "server-id", name: payload.name };
      },
      async getRecipeById(id: string) {
        calls.verify += 1;
        if (options.verifyError !== undefined) throw options.verifyError;
        return options.verifyResult === undefined ? { id } : options.verifyResult;
      },
    };

    const saver = new AnyListRecipeSaver(async () => {
      calls.login += 1;
      if (options.loginError !== undefined) throw options.loginError;
      return client;
    });

    return { saver, calls };
  }

  async function run(options: FakeOptions) {
    const { saver, calls } = saverWith(options);
    stubFetchFor(golden);

    const outcome = await importRecipe(golden.url, {
      deps: deps({ parseRecipe: async () => recipe, createSaver: () => saver }),
    }).catch((thrown: unknown) => thrown);

    return { outcome, calls };
  }

  it("succeeds and verifies exactly once on the happy path", async () => {
    const { outcome, calls } = await run({});

    expect(outcome).toEqual({ recipe, saved: { name: recipe.title, identifier: "server-id" } });
    expect(calls).toEqual({ login: 1, create: 1, verify: 1 });
  });

  it("classifies a login failure as save_failed and never attempts the write", async () => {
    const { outcome, calls } = await run({ loginError: Object.assign(new Error("bad creds"), { response: { statusCode: 401 } }) });

    expect((outcome as ImportError).kind).toBe("save_failed");
    expect(calls.create).toBe(0);
  });

  it("classifies a definite create failure as save_failed and does not retry", async () => {
    const { outcome, calls } = await run({
      createError: Object.assign(new Error("rejected"), { response: { statusCode: 400 } }),
    });

    expect((outcome as ImportError).kind).toBe("save_failed");
    expect(calls.create).toBe(1);
    expect(calls.verify).toBe(0);
  });

  it("FINDING QA-009: an ambiguous create timeout is indistinguishable from a definite failure", async () => {
    // ADR-012 needs FAILED_SAFE (definitely no write) told apart from AMBIGUOUS
    // (the write may have landed). A timeout after createRecipe was sent is the
    // textbook AMBIGUOUS case, and it produces exactly the same ImportError
    // kind and the same fixed message as an outright rejection above.
    // Not a defect today — there is no idempotency store to record a state in —
    // but the distinction must exist before POST /api/exports/anylist ships.
    const timeout = Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
    const ambiguous = await run({ createError: timeout });
    const definite = await run({ createError: new Error("400 Bad Request") });

    expect((ambiguous.outcome as ImportError).kind).toBe("save_failed");
    expect((definite.outcome as ImportError).kind).toBe("save_failed");
    expect((ambiguous.outcome as ImportError).message).toBe((definite.outcome as ImportError).message);

    // The important half: neither one retried the write.
    expect(ambiguous.calls.create).toBe(1);
    expect(definite.calls.create).toBe(1);
  });

  it("classifies an unreadable verification as save_failed without writing again", async () => {
    const { outcome, calls } = await run({
      verifyError: Object.assign(new Error("gateway"), { response: { statusCode: 503 } }),
    });

    expect((outcome as ImportError).kind).toBe("save_failed");
    expect(calls.create).toBe(1);
    expect(calls.verify).toBe(1);
  });

  it("classifies a recipe that cannot be found afterwards as save_failed without writing again", async () => {
    const { outcome, calls } = await run({ verifyResult: null });

    expect((outcome as ImportError).kind).toBe("save_failed");
    expect(calls.create).toBe(1);
  });

  it("classifies a mismatched id on read-back as save_failed", async () => {
    const { outcome, calls } = await run({ verifyResult: { id: "someone-elses-recipe" } });

    expect((outcome as ImportError).kind).toBe("save_failed");
    expect(calls.create).toBe(1);
  });

  it("classifies a non-AnyList throw on the save path as internal, not save_failed", async () => {
    stubFetchFor(golden);
    const error = await importRecipe(golden.url, {
      deps: deps({
        parseRecipe: async () => recipe,
        createSaver: () => {
          throw new TypeError("cannot read properties of undefined");
        },
      }),
    }).catch((thrown: unknown) => thrown);

    expect((error as ImportError).kind).toBe("internal");
  });

  it("never writes more than once, whatever fails", async () => {
    const failures: FakeOptions[] = [
      { createError: new Error("boom") },
      { createError: Object.assign(new Error("timeout"), { name: "TimeoutError" }) },
      { verifyError: new Error("boom") },
      { verifyResult: null },
      { verifyResult: { id: "other" } },
    ];

    for (const failure of failures) {
      const { calls } = await run(failure);
      expect(calls.create).toBeLessThanOrEqual(1);
      vi.unstubAllGlobals();
    }
  });
});
