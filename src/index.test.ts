import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

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

  it("writes nothing to stdout when no URL is given", async () => {
    const { stdout, stderr } = await runCli();

    expect(stdout).toBe("");
    expect(stderr).toContain("No URL provided.");
  }, 30_000);
});
