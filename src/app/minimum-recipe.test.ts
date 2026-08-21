import { describe, expect, it, vi } from "vitest";

import type { RecipeSaver } from "../anylist/types.js";
import { recipeWith, sourceContent, TEST_URL, validRecipe } from "../test-support/fixtures.js";
import { extractRecipe, ImportError, importRecipe, type ImportDeps } from "./import-service.js";
import { isUsableRecipe } from "./minimum-recipe.js";

const saver: RecipeSaver = {
  save: async () => ({ name: validRecipe.title, identifier: "anylist-id" }),
};

function deps(overrides: Partial<ImportDeps> = {}): ImportDeps {
  return {
    fetchSourceContent: async () => sourceContent,
    parseRecipe: async () => validRecipe,
    createSaver: () => saver,
    ...overrides,
  };
}

describe("isUsableRecipe", () => {
  it("accepts a recipe with a title, an ingredient, and an instruction", () => {
    expect(isUsableRecipe(validRecipe)).toBe(true);
  });

  it.each([
    ["a blank title", recipeWith({ title: "   " })],
    ["no ingredients", recipeWith({ ingredients: [] })],
    ["no instructions", recipeWith({ instructions: [] })],
  ])("rejects %s", (_label, recipe) => {
    expect(isUsableRecipe(recipe)).toBe(false);
  });

  it("ignores confidence entirely", () => {
    // ADR-019: the gate is structural. QA established that confidence does not
    // predict whether edits are required, so gating on it would reject usable
    // recipes and admit unusable ones.
    expect(isUsableRecipe(recipeWith({ confidence: 0 }))).toBe(true);
    expect(isUsableRecipe(recipeWith({ confidence: 1, ingredients: [] }))).toBe(false);
  });

  it("ignores warnings entirely", () => {
    expect(isUsableRecipe(recipeWith({ warnings: ["a", "b", "c", "d"] }))).toBe(true);
  });
});

describe("the gate lives at the shared boundary (QA-003)", () => {
  const empty = recipeWith({ ingredients: [], instructions: [] });

  it("fails extraction with the safe extraction-failure kind", async () => {
    const error = await extractRecipe(TEST_URL, { deps: deps({ parseRecipe: async () => empty }) })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ImportError);
    expect((error as ImportError).kind).toBe("extraction_failed");
  });

  it("stops the legacy one-shot path from writing an empty recipe to AnyList", async () => {
    // This is the reason the gate is not in the /api/imports route handler.
    // POST /api/import is the path that actually writes, so holding it to a
    // weaker standard would have been exactly backwards.
    const save = vi.fn(saver.save);

    const error = await importRecipe(TEST_URL, {
      deps: deps({ parseRecipe: async () => empty, createSaver: () => ({ save }) }),
    }).catch((thrown: unknown) => thrown);

    expect((error as ImportError).kind).toBe("extraction_failed");
    expect(save).not.toHaveBeenCalled();
  });

  it("stops a dry run too, so the CLI never prints an unusable recipe", async () => {
    const error = await importRecipe(TEST_URL, {
      dryRun: true,
      deps: deps({ parseRecipe: async () => empty }),
    }).catch((thrown: unknown) => thrown);

    expect((error as ImportError).kind).toBe("extraction_failed");
  });

  it("still saves a usable recipe that carries warnings", async () => {
    const result = await importRecipe(TEST_URL, {
      deps: deps({ parseRecipe: async () => recipeWith({ confidence: 0.1, warnings: ["a", "b"] }) }),
    });

    expect(result.saved).toEqual({ name: validRecipe.title, identifier: "anylist-id" });
  });
});

describe("extractRecipe", () => {
  it("reports the fetched source, so telemetry can count without holding the caption", async () => {
    const seen: string[] = [];

    await extractRecipe(TEST_URL, {
      deps: deps(),
      onSourceContent: (content) => seen.push(content.textSource),
    });

    expect(seen).toEqual(["caption"]);
  });

  it("never constructs the saver", async () => {
    const createSaver = vi.fn(() => saver);

    await extractRecipe(TEST_URL, { deps: deps({ createSaver }) });

    expect(createSaver).not.toHaveBeenCalled();
  });

  it("is bounded, so a hung source fetch cannot run past the request budget", async () => {
    const hangs = deps({ fetchSourceContent: () => new Promise<never>(() => undefined) });

    const error = await extractRecipe(TEST_URL, { deps: hangs, timeoutMs: 20 }).catch(
      (thrown: unknown) => thrown,
    );

    expect((error as ImportError).kind).toBe("extraction_failed");
  });
});
