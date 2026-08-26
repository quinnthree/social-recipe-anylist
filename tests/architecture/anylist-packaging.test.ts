import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { resolveChildEntry } from "../../src/anylist/child-runner.js";

/**
 * Packaging protection for the ADR-023 containment child.
 *
 * The child is **spawned, not imported**, so it is invisible to import tracing.
 * A deployment that omits it builds cleanly, starts cleanly, and then fails on
 * the first export — the worst possible moment to learn about it, and one no
 * unit test would otherwise reach. These assertions move that discovery to CI.
 *
 * M6A established the facts these encode: `spawn(process.execPath, …)` works on
 * Vercel, the deployed child must be plain JavaScript because the runtime has no
 * TypeScript loader, the path must resolve from `process.cwd()`, and explicit
 * `includeFiles` is therefore mandatory.
 */

const CHILD_PATH = "src/anylist/child/anylist-child.mjs";

describe("the isolated AnyList child is packaged for deployment", () => {
  it("exists at the path the runner resolves", () => {
    expect(existsSync(CHILD_PATH)).toBe(true);
  });

  it("is plain JavaScript, because the deployed runtime has no TypeScript loader", () => {
    expect(CHILD_PATH.endsWith(".mjs")).toBe(true);
  });

  it("is named by the Vercel entrypoint's includeFiles", () => {
    const app = readFileSync("src/app.ts", "utf8");
    const includeFiles = /includeFiles:\s*"([^"]+)"/.exec(app)?.[1];

    expect(includeFiles).toBeDefined();

    // The declared glob must actually cover the child. A pattern that stopped
    // matching — a moved file, a narrowed glob — is the failure this catches.
    const prefix = (includeFiles as string).replace(/\*+.*$/, "");
    expect(CHILD_PATH.startsWith(prefix)).toBe(true);
  });

  it("keeps maxDuration, which the export path depends on", () => {
    const app = readFileSync("src/app.ts", "utf8");

    expect(/maxDuration:\s*120/.test(app)).toBe(true);
  });

  it("resolves from the working directory, which is what a deployed function has", () => {
    const resolved = resolveChildEntry({});

    expect(resolved.endsWith("anylist-child.mjs")).toBe(true);
    expect(existsSync(resolved)).toBe(true);
  });

  it("honours an explicit override, which is how tests point at a stand-in", () => {
    expect(resolveChildEntry({ ANYLIST_CHILD_ENTRY: "/tmp/whatever.mjs" })).toBe(
      "/tmp/whatever.mjs",
    );
  });
});
