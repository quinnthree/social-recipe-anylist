import { describe, expect, it } from "vitest";

import type { Recipe } from "../recipe/schema.js";
import { AnyListRecipeSaver, type AnyListClientLike } from "./client.js";
import { AnyListError } from "./types.js";

const PASSWORD = "sup3r-s3cret-p@ssword";
const EMAIL = "cook@example.com";
const CREATED_ID = "recipe-id-from-create";

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
  verifyError?: unknown;
  /** What getRecipeById returns. Defaults to the created recipe. */
  verifyResult?: { id: string } | null;
}

function fakeClient(options: FakeOptions = {}) {
  const calls = { create: 0, verify: 0, verifiedIds: [] as string[], payloads: [] as unknown[] };

  const client: AnyListClientLike = {
    async createRecipe(payload) {
      calls.create += 1;
      calls.payloads.push(payload);
      if (options.createError !== undefined) throw options.createError;
      return { id: CREATED_ID, name: payload.name };
    },
    async getRecipeById(recipeId) {
      calls.verify += 1;
      calls.verifiedIds.push(recipeId);
      if (options.verifyError !== undefined) throw options.verifyError;
      return options.verifyResult === undefined ? { id: CREATED_ID } : options.verifyResult;
    },
  };

  const connect = async (): Promise<AnyListClientLike> => {
    if (options.loginError !== undefined) throw options.loginError;
    return client;
  };

  return { client, connect, calls };
}

/** Shaped like a transport error whose innards reach the submitted credentials. */
function credentialBearingError(statusCode: number): Error {
  return Object.assign(new Error(`Request failed for ${EMAIL} with password ${PASSWORD}`), {
    response: {
      statusCode,
      body: `{"error":"bad credentials for ${EMAIL}"}`,
      request: { options: { body: `password=${PASSWORD}` } },
    },
  });
}

describe("AnyListRecipeSaver.save", () => {
  it("creates the recipe and returns the id createRecipe reported", async () => {
    const { connect, calls } = fakeClient();
    const result = await new AnyListRecipeSaver(connect).save(recipe);

    expect(result).toEqual({ name: "Cottage Cheese Brownies", identifier: CREATED_ID });
    expect(calls.create).toBe(1);
  });

  it("sends the mapped payload, not the internal Recipe", async () => {
    const { connect, calls } = fakeClient();
    await new AnyListRecipeSaver(connect).save(recipe);

    expect(calls.payloads[0]).toEqual({
      name: "Cottage Cheese Brownies",
      ingredients: [{ name: "cottage cheese", quantity: "16 oz" }],
      preparationSteps: ["Blend until smooth."],
      sourceUrl: "https://www.tiktok.com/@creator/video/7123456789",
      sourceName: "creator",
      servings: "9",
      note: "Cook time stated in source: 35–40 minutes",
      cookTime: 35,
    });
  });

  it("does not transmit rawText", async () => {
    const { connect, calls } = fakeClient();
    await new AnyListRecipeSaver(connect).save(recipe);

    expect(JSON.stringify(calls.payloads[0])).not.toContain("rawText");
  });

  describe("verification", () => {
    it("verifies by reading the recipe back by the id createRecipe reported", async () => {
      const { connect, calls } = fakeClient();
      await new AnyListRecipeSaver(connect).save(recipe);

      expect(calls.verify).toBe(1);
      expect(calls.verifiedIds).toEqual([CREATED_ID]);
    });

    it("fails when the read returns nothing", async () => {
      const { connect } = fakeClient({ verifyResult: null });

      await expect(new AnyListRecipeSaver(connect).save(recipe)).rejects.toThrow(
        "AnyList accepted the save request, but the recipe could not be verified in the account.",
      );
    });

    it("fails when the read returns a different id", async () => {
      const { connect } = fakeClient({ verifyResult: { id: "some-other-recipe" } });

      await expect(new AnyListRecipeSaver(connect).save(recipe)).rejects.toThrow(
        "AnyList accepted the save request, but the recipe could not be verified in the account.",
      );
    });

    it("reports a distinct error when the read itself fails", async () => {
      const { connect } = fakeClient({ verifyError: credentialBearingError(503) });

      await expect(new AnyListRecipeSaver(connect).save(recipe)).rejects.toThrow(
        "AnyList accepted the save request, but the recipe could not be read back to verify it. (HTTP 503)",
      );
    });

    it("does not create a second recipe or retry while verifying", async () => {
      const { connect, calls } = fakeClient({ verifyResult: null });

      await new AnyListRecipeSaver(connect).save(recipe).catch(() => undefined);

      expect(calls.create).toBe(1);
      expect(calls.verify).toBe(1);
    });
  });

  describe("error redaction", () => {
    it("replaces a login failure with a fixed application message", async () => {
      const { connect } = fakeClient({ loginError: credentialBearingError(401) });

      await expect(new AnyListRecipeSaver(connect).save(recipe)).rejects.toThrow(
        "AnyList login failed. Check ANYLIST_EMAIL and ANYLIST_PASSWORD in .env. (HTTP 401)",
      );
    });

    it("replaces a createRecipe failure with a fixed application message", async () => {
      const { connect } = fakeClient({ createError: credentialBearingError(500) });

      await expect(new AnyListRecipeSaver(connect).save(recipe)).rejects.toThrow(
        "Failed to save the recipe to AnyList. (HTTP 500)",
      );
    });

    it("omits the status when none is safely available", async () => {
      const { connect } = fakeClient({ createError: new Error("native panic: whatever") });

      await expect(new AnyListRecipeSaver(connect).save(recipe)).rejects.toThrow(
        "Failed to save the recipe to AnyList.",
      );
    });

    it("never lets credentials reach the thrown error, on any failure path", async () => {
      const failures: FakeOptions[] = [
        { loginError: credentialBearingError(401) },
        { createError: credentialBearingError(500) },
        { verifyError: credentialBearingError(503) },
        { verifyResult: null },
      ];

      for (const failure of failures) {
        const { connect } = fakeClient(failure);
        const error = await new AnyListRecipeSaver(connect)
          .save(recipe)
          .catch((thrown: unknown) => thrown);

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
    let thrown: Error | null = null;
    try {
      AnyListRecipeSaver.fromEnvironment({ ANYLIST_EMAIL: "   ", ANYLIST_PASSWORD: PASSWORD });
    } catch (error: unknown) {
      thrown = error as Error;
    }

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
