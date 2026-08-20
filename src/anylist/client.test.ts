import { describe, expect, it, vi } from "vitest";

import type { Recipe } from "../recipe/schema.js";
import { AnyListRecipeSaver, type AnyListClientLike } from "./client.js";
import { AnyListError } from "./types.js";

const PASSWORD = "sup3r-s3cret-p@ssword";
const EMAIL = "cook@example.com";

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
    creator: "creator",
    url: "https://www.tiktok.com/@creator/video/7123456789",
  },
  confidence: 1,
  warnings: [],
};

interface FakeOptions {
  loginError?: unknown;
  createError?: unknown;
  saveError?: unknown;
}

function fakeClient(options: FakeOptions = {}) {
  const calls = { login: 0, teardown: 0, save: 0, payloads: [] as unknown[] };

  const client: AnyListClientLike = {
    async login(connectWebSocket?: boolean) {
      calls.login += 1;
      expect(connectWebSocket).toBe(false);
      if (options.loginError !== undefined) throw options.loginError;
    },
    async createRecipe(payload) {
      calls.payloads.push(payload);
      if (options.createError !== undefined) throw options.createError;
      return {
        identifier: "recipe-uuid-1234",
        async save() {
          calls.save += 1;
          if (options.saveError !== undefined) throw options.saveError;
        },
      };
    },
    teardown() {
      calls.teardown += 1;
    },
  };

  return { client, calls };
}

/** Shaped like a got HTTPError: the submitted credentials are reachable from it. */
function gotStyleError(statusCode: number): Error {
  return Object.assign(new Error(`Response code ${statusCode}`), {
    response: {
      statusCode,
      body: `{"error":"bad credentials for ${EMAIL}"}`,
      request: { options: { url: "https://www.anylist.com/auth/token", body: `password=${PASSWORD}` } },
    },
  });
}

describe("AnyListRecipeSaver.save", () => {
  it("logs in without a WebSocket, saves, and reports the recipe", async () => {
    const { client, calls } = fakeClient();
    const result = await new AnyListRecipeSaver(async () => client).save(recipe);

    expect(result).toEqual({ name: "Cottage Cheese Brownies", identifier: "recipe-uuid-1234" });
    expect(calls.login).toBe(1);
    expect(calls.save).toBe(1);
  });

  it("sends the mapped payload, not the internal Recipe", async () => {
    const { client, calls } = fakeClient();
    await new AnyListRecipeSaver(async () => client).save(recipe);

    expect(calls.payloads[0]).toMatchObject({
      name: "Cottage Cheese Brownies",
      sourceUrl: "https://www.tiktok.com/@creator/video/7123456789",
      cookTime: 2100,
      note: "Cook time stated in source: 35–40 minutes",
    });
  });

  describe("teardown", () => {
    it("runs after a successful save", async () => {
      const { client, calls } = fakeClient();
      await new AnyListRecipeSaver(async () => client).save(recipe);
      expect(calls.teardown).toBe(1);
    });

    it("runs when login fails", async () => {
      const { client, calls } = fakeClient({ loginError: new Error("nope") });
      await expect(new AnyListRecipeSaver(async () => client).save(recipe)).rejects.toThrow(
        AnyListError,
      );
      expect(calls.teardown).toBe(1);
    });

    it("runs when recipe creation fails", async () => {
      const { client, calls } = fakeClient({ createError: new Error("nope") });
      await expect(new AnyListRecipeSaver(async () => client).save(recipe)).rejects.toThrow(
        AnyListError,
      );
      expect(calls.teardown).toBe(1);
    });

    it("runs when saving fails", async () => {
      const { client, calls } = fakeClient({ saveError: new Error("nope") });
      await expect(new AnyListRecipeSaver(async () => client).save(recipe)).rejects.toThrow(
        AnyListError,
      );
      expect(calls.teardown).toBe(1);
    });
  });

  describe("error redaction", () => {
    it("replaces a login failure with a fixed application message", async () => {
      const { client } = fakeClient({ loginError: gotStyleError(401) });
      const saver = new AnyListRecipeSaver(async () => client);

      await expect(saver.save(recipe)).rejects.toThrow(
        "AnyList login failed. Check ANYLIST_EMAIL and ANYLIST_PASSWORD in .env. (HTTP 401)",
      );
    });

    it("replaces a save failure with a fixed application message", async () => {
      const { client } = fakeClient({ saveError: gotStyleError(500) });
      const saver = new AnyListRecipeSaver(async () => client);

      await expect(saver.save(recipe)).rejects.toThrow(
        "Failed to save the recipe to AnyList. (HTTP 500)",
      );
    });

    it("omits the status when none is safely available", async () => {
      const { client } = fakeClient({ loginError: new Error("socket hang up") });
      const saver = new AnyListRecipeSaver(async () => client);

      await expect(saver.save(recipe)).rejects.toThrow(
        "AnyList login failed. Check ANYLIST_EMAIL and ANYLIST_PASSWORD in .env.",
      );
    });

    it("never lets the password reach the thrown error, including via cause or stack", async () => {
      for (const failure of [
        { loginError: gotStyleError(401) },
        { createError: gotStyleError(403) },
        { saveError: gotStyleError(500) },
      ]) {
        const { client } = fakeClient(failure);
        const saver = new AnyListRecipeSaver(async () => client);

        const error = await saver.save(recipe).catch((thrown: unknown) => thrown);

        expect(error).toBeInstanceOf(AnyListError);
        const exposed = [
          (error as Error).message,
          (error as Error).stack ?? "",
          String((error as { cause?: unknown }).cause ?? ""),
          JSON.stringify(error, Object.getOwnPropertyNames(error)),
        ].join("\n");

        expect(exposed).not.toContain(PASSWORD);
        expect(exposed).not.toContain(EMAIL);
        expect((error as { cause?: unknown }).cause).toBeUndefined();
      }
    });
  });

  describe("console handling", () => {
    it("suppresses the package's console output and restores the originals", async () => {
      const info = vi.fn();
      const error = vi.fn();
      const originalInfo = console.info;
      const originalError = console.error;
      console.info = info;
      console.error = error;

      try {
        const client: AnyListClientLike = {
          async login() {
            // The real package logs progress here; console.info writes to stdout.
            console.info("No saved tokens found, fetching new tokens using credentials");
            console.error("Endpoint https://www.anylist.com/... returned status code 401");
          },
          async createRecipe() {
            return { identifier: "id", async save() {} };
          },
          teardown() {},
        };

        await new AnyListRecipeSaver(async () => client).save(recipe);

        expect(info).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
        expect(console.info).toBe(info);
        expect(console.error).toBe(error);
      } finally {
        console.info = originalInfo;
        console.error = originalError;
      }
    });

    it("restores the originals even when the operation throws", async () => {
      const info = vi.fn();
      const originalInfo = console.info;
      console.info = info;

      try {
        const { client } = fakeClient({ loginError: new Error("nope") });
        await new AnyListRecipeSaver(async () => client).save(recipe).catch(() => undefined);
        expect(console.info).toBe(info);
      } finally {
        console.info = originalInfo;
      }
    });
  });
});

describe("AnyListRecipeSaver.fromEnvironment", () => {
  it("fails clearly when credentials are absent, without echoing any value", () => {
    expect(() => AnyListRecipeSaver.fromEnvironment({})).toThrow(AnyListError);
    expect(() => AnyListRecipeSaver.fromEnvironment({})).toThrow(
      "Missing AnyList credentials. Set ANYLIST_EMAIL and ANYLIST_PASSWORD in .env (see .env.example).",
    );
  });

  it("fails when only one of the two is set", () => {
    expect(() => AnyListRecipeSaver.fromEnvironment({ ANYLIST_EMAIL: EMAIL })).toThrow(AnyListError);
    expect(() => AnyListRecipeSaver.fromEnvironment({ ANYLIST_PASSWORD: PASSWORD })).toThrow(
      AnyListError,
    );
  });

  it("does not put the password in the error when the email is blank", () => {
    const thrown = (() => {
      try {
        AnyListRecipeSaver.fromEnvironment({ ANYLIST_EMAIL: "   ", ANYLIST_PASSWORD: PASSWORD });
      } catch (error: unknown) {
        return error as Error;
      }
      return null;
    })();

    expect(thrown?.message).not.toContain(PASSWORD);
  });

  it("builds a saver when both are present", () => {
    const saver = AnyListRecipeSaver.fromEnvironment({
      ANYLIST_EMAIL: EMAIL,
      ANYLIST_PASSWORD: PASSWORD,
    });
    expect(saver).toBeInstanceOf(AnyListRecipeSaver);
  });
});
