import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { parseArgs } from "./index.js";

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

describe("CLI output contract", () => {
  const URL = "https://www.tiktok.com/@creator/video/7123456789";

  it("prints only the usage error and nothing on stdout for a bad flag", async () => {
    const { stdout, stderr } = await runCli(URL, "--dryrun");

    expect(stdout).toBe("");
    expect(stderr).toContain('Unknown flag "--dryrun"');
  }, 30_000);

  it("still rejects an unsupported platform after the service refactor", async () => {
    const { stdout, stderr } = await runCli("https://youtube.com/watch?v=abc");

    expect(stdout).toBe("");
    expect(stderr).toContain("Unsupported platform for host");
  }, 30_000);

  it("still rejects an unsupported platform on a dry run", async () => {
    const { stdout, stderr } = await runCli("https://youtube.com/watch?v=abc", "--dry-run");

    expect(stdout).toBe("");
    expect(stderr).toContain("Unsupported platform for host");
  }, 30_000);
});
