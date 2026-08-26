import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The ADR-023 containment boundary, enforced as a property of the source tree.
 *
 * Containment is **not** self-enforcing. It holds only while every native
 * AnyList invocation crosses the child-process boundary; one direct import of
 * `@anylist-napi/anylist-napi` in a parent-process module silently restores the
 * leak — the native library writes `set-cookie` to file descriptor 2 from Rust,
 * below anything JavaScript can intercept — and no containment code would
 * notice. So it is checked here instead.
 *
 * The allowlist is a literal list rather than a pattern. Adding to it is a
 * visible, reviewable act, which is exactly the decision this guard exists to
 * force someone to make consciously.
 */

const PACKAGE = "@anylist-napi/anylist-napi";

/**
 * The single designated child entrypoint. **Nothing else may be added here
 * without a decision that containment no longer holds.**
 */
const RUNTIME_ALLOWLIST: ReadonlySet<string> = new Set([
  "src/anylist/child/anylist-child.mjs",
]);

/**
 * Type-only imports are erased at compile time and load nothing, so they cannot
 * reintroduce the leak. They are listed rather than pattern-matched, so an
 * `import type` that later loses its `type` keyword is caught.
 */
const TYPE_ONLY_ALLOWLIST: ReadonlySet<string> = new Set(["src/anylist/types.ts"]);

/** Production source roots. `api/` is scanned whenever it exists. */
const PRODUCTION_ROOTS = ["src", "api"].filter((root) => existsSync(root));

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const TYPE_ONLY_PATTERN = new RegExp(`import\\s+type\\s[^;]*from\\s*["']${escape(PACKAGE)}["']`);

/** A runtime reference: static import, dynamic import, or require. */
const RUNTIME_PATTERNS: readonly RegExp[] = [
  new RegExp(`from\\s*["']${escape(PACKAGE)}["']`),
  new RegExp(`import\\s*\\(\\s*["']${escape(PACKAGE)}["']`),
  new RegExp(`require\\s*\\(\\s*["']${escape(PACKAGE)}["']`),
];

export function classify(text: string): "runtime" | "type-only" | "none" {
  // Type-only imports are removed first, so what remains is only code that
  // actually loads the module. A file carrying both is therefore classified by
  // its loading import, which is the one that matters.
  const withoutTypeImports = text.replace(new RegExp(TYPE_ONLY_PATTERN.source, "g"), "");

  if (RUNTIME_PATTERNS.some((pattern) => pattern.test(withoutTypeImports))) return "runtime";

  return TYPE_ONLY_PATTERN.test(text) ? "type-only" : "none";
}

function sourceFiles(root: string): string[] {
  const found: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      // Declaration files declare types and load nothing.
      if (/\.d\.[cm]?ts$/.test(entry)) continue;
      if (/\.(?:ts|mts|cts|js|mjs|cjs)$/.test(entry)) found.push(path);
    }
  };

  walk(root);
  return found;
}

describe("the AnyList native package loads only in the designated child", () => {
  const scanned: Array<{ file: string; kind: ReturnType<typeof classify> }> = [];

  for (const root of PRODUCTION_ROOTS) {
    for (const path of sourceFiles(root)) {
      const file = relative(process.cwd(), path).split(sep).join("/");
      scanned.push({ file, kind: classify(readFileSync(path, "utf8")) });
    }
  }

  it("has no unlisted runtime importer in production source", () => {
    const offenders = scanned
      .filter(({ file, kind }) => kind === "runtime" && !RUNTIME_ALLOWLIST.has(file))
      .map(({ file }) => file);

    // The message names the file, so a failure is actionable without reading
    // this test. It never prints file contents.
    expect(offenders).toEqual([]);
  });

  it("has no unlisted type-only importer either", () => {
    const offenders = scanned
      .filter(({ file, kind }) => kind === "type-only" && !TYPE_ONLY_ALLOWLIST.has(file))
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  it("scans both src/ and api/ when present", () => {
    expect(PRODUCTION_ROOTS).toContain("src");
    // `api/` is optional today; when it exists it must be covered, because the
    // parent half of containment would live there and that is exactly where a
    // convenience import would appear.
    if (existsSync("api")) expect(PRODUCTION_ROOTS).toContain("api");
  });

  it("finds the designated child itself, so the check cannot pass vacuously", () => {
    const child = scanned.find(({ file }) => file === "src/anylist/child/anylist-child.mjs");

    expect(child?.kind).toBe("runtime");
  });

  it("confirms the old in-process importer is gone", () => {
    // Before this milestone `src/anylist/client.ts` held the dynamic import.
    // It must not be on the allowlist and must no longer load the package.
    expect(RUNTIME_ALLOWLIST.has("src/anylist/client.ts")).toBe(false);
    expect(classify(readFileSync("src/anylist/client.ts", "utf8"))).toBe("none");
  });

  describe("detection", () => {
    it("rejects a static import", () => {
      expect(classify(`import { AnyListClient } from "${PACKAGE}";`)).toBe("runtime");
    });

    it("rejects a dynamic import", () => {
      expect(classify(`const mod = await import("${PACKAGE}");`)).toBe("runtime");
    });

    it("rejects require()", () => {
      expect(classify(`const mod = require("${PACKAGE}");`)).toBe("runtime");
    });

    it("permits a type-only import", () => {
      expect(classify(`import type { CreateRecipeOptions } from "${PACKAGE}";`)).toBe("type-only");
    });

    it("classifies a file with both as a runtime importer", () => {
      const both = `import type { A } from "${PACKAGE}";\nconst m = await import("${PACKAGE}");`;

      expect(classify(both)).toBe("runtime");
    });

    it("does not mistake a string mention for an import", () => {
      expect(classify(`expect(pkg.dependencies["${PACKAGE}"]).toBe("1.1.1");`)).toBe("none");
    });
  });
});
