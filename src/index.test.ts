import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import type { SourceContent } from "./social/types.js";
import type { Recipe } from "./recipe/schema.js";
import { parseArgs, runImport } from "./index.js";

const run = promisify(execFile);

/** Runs the CLI exactly as `npm run import` does, capturing both streams. */
async function runCli(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await run("node_modules/.bin/tsx", ["src/index.ts", ...args]);
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

describe("CLI output streams", () => {
  it("writes nothing to stdout when extraction fails", async () => {
    const { stdout, stderr } = await runCli("https://youtube.com/watch?v=abc");

    // dotenv's banner would land here and corrupt the JSON on the success path.
    expect(stdout).toBe("");
    expect(stderr).toContain("Unsupported platform");
  }, 30_000);

  it("writes nothing to stdout when an unknown flag is passed", async () => {
    const { stdout, stderr } = await runCli("https://www.tiktok.com/@a/video/1", "--dryrun");

    expect(stdout).toBe("");
    expect(stderr).toContain('Unknown flag "--dryrun"');
  }, 30_000);

  it("writes nothing to stdout when no URL is given", async () => {
    const { stdout, stderr } = await runCli();

    expect(stdout).toBe("");
    expect(stderr).toContain("No URL provided.");
  }, 30_000);
});

describe("parseArgs", () => {
  const URL = "https://www.tiktok.com/@creator/video/7123456789";

  it("reads a bare URL as a normal run", () => {
    expect(parseArgs([URL])).toEqual({ url: URL, dryRun: false });
  });

  it("accepts --dry-run after the URL", () => {
    expect(parseArgs([URL, "--dry-run"])).toEqual({ url: URL, dryRun: true });
  });

  it("accepts --dry-run before the URL", () => {
    expect(parseArgs(["--dry-run", URL])).toEqual({ url: URL, dryRun: true });
  });

  it("trims surrounding whitespace from the URL", () => {
    expect(parseArgs([`  ${URL}  `]).url).toBe(URL);
  });

  it("rejects an unknown flag rather than ignoring it", () => {
    expect(() => parseArgs([URL, "--dryrun"])).toThrow('Unknown flag "--dryrun"');
    expect(() => parseArgs([URL, "-n"])).toThrow('Unknown flag "-n"');
  });

  it("rejects a second URL", () => {
    expect(() => parseArgs([URL, "https://example.com"])).toThrow("Expected a single URL");
  });

  it("rejects an empty argument list", () => {
    expect(() => parseArgs([])).toThrow("No URL provided.");
    expect(() => parseArgs(["--dry-run"])).toThrow("No URL provided.");
  });
});

describe("runImport", () => {
  const URL = "https://www.tiktok.com/@creator/video/7123456789";

  const content: SourceContent = {
    platform: "tiktok",
    url: URL,
    creator: "creator",
    text: "Cottage cheese brownies",
    textSource: "caption",
  };

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
    source: { platform: "tiktok", creator: "creator", url: URL },
    confidence: 1,
    warnings: [],
  };

  function deps(overrides: { createSaver?: () => never } = {}) {
    return {
      fetchSourceContent: async () => content,
      parseRecipe: async () => recipe,
      createSaver:
        overrides.createSaver ??
        (() => ({ save: async () => ({ name: recipe.title, identifier: "server-id" }) })),
    };
  }

  it("prints the recipe JSON on a dry run", async () => {
    const output = await runImport({ url: URL, dryRun: true }, deps());

    expect(JSON.parse(output)).toEqual(recipe);
  });

  it("never constructs the AnyList adapter on a dry run", async () => {
    const createSaver = (): never => {
      throw new Error("AnyList must not be constructed during a dry run");
    };

    await expect(
      runImport({ url: URL, dryRun: true }, deps({ createSaver })),
    ).resolves.toContain("Cottage Cheese Brownies");
  });

  it("saves and reports success on a normal run", async () => {
    const output = await runImport({ url: URL, dryRun: false }, deps());

    expect(output).toBe("✓ Cottage Cheese Brownies saved to AnyList");
  });

  it("does not report success when verification fails", async () => {
    const failing = {
      ...deps(),
      createSaver: () => ({
        save: async () => {
          throw new Error("AnyList accepted the save request, but the recipe could not be verified in the account.");
        },
      }),
    };

    await expect(runImport({ url: URL, dryRun: false }, failing)).rejects.toThrow(
      "could not be verified",
    );
  });
});
