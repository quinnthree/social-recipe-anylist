import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * B4-C is dormant reference infrastructure, enforced as a property of the source
 * tree.
 *
 * The unit engine ships with no user-facing behaviour: nothing in the API, the
 * extraction pipeline, or the AnyList adapter may reach it. That is easy to
 * state and easy to violate by accident — one convenience import from a route
 * handler and a milestone that promised "no user-facing behaviour" is quietly
 * shipping conversions to real users, through an engine no product decision has
 * approved yet.
 *
 * So dormancy is checked rather than assumed, the same way ADR-023 containment
 * is. The allowlist is a literal list; adding to it is a visible, reviewable act
 * and should coincide with a decision that the engine is no longer dormant.
 */

/** The engine's own directory. Modules inside it may of course import each other. */
const ENGINE_DIRECTORY = "src/units/";

/**
 * Production files permitted to reference the engine.
 *
 * `canonical-compatibility.ts` is inside the engine and imports the recipe
 * schema **type-only**, which is the opposite direction and is erased at
 * compile time. Nothing else is listed, and nothing else should be until the
 * engine is deliberately activated.
 */
const ALLOWED_IMPORTERS: ReadonlySet<string> = new Set<string>();

const PRODUCTION_ROOTS = ["src", "api"].filter((root) => existsSync(root));

/** The surfaces that must never reach the engine, named for a clearer failure. */
const FORBIDDEN_SURFACES: ReadonlyArray<readonly [label: string, prefix: string]> = [
  ["HTTP routes", "src/http/"],
  ["the extraction parser", "src/recipe/"],
  ["the social ingestion adapters", "src/social/"],
  ["the AnyList adapter", "src/anylist/"],
  ["the application services", "src/app/"],
  ["the idempotency store", "src/idempotency/"],
  ["the production entrypoints", "src/index.ts"],
  ["the server entrypoint", "src/server.ts"],
];

/** Any import, dynamic import, or require that resolves into `src/units/`. */
const ENGINE_REFERENCE = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'][^"']*\/units\/[^"']*["']/;

function sourceFiles(root: string): string[] {
  const found: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (/\.d\.[cm]?ts$/.test(entry)) continue;
      if (/\.(?:ts|mts|cts|js|mjs|cjs)$/.test(entry)) found.push(path);
    }
  };

  walk(root);
  return found;
}

const scanned = PRODUCTION_ROOTS.flatMap((root) =>
  sourceFiles(root).map((path) => {
    const file = relative(process.cwd(), path).split(sep).join("/");
    return { file, text: readFileSync(path, "utf8") };
  }),
);

/** Production files outside the engine that reference it. */
const importers = scanned
  .filter(({ file }) => !file.startsWith(ENGINE_DIRECTORY))
  .filter(({ text }) => ENGINE_REFERENCE.test(text))
  .map(({ file }) => file);

describe("the unit engine is not reachable from production code", () => {
  it("has no unlisted importer anywhere in src/ or api/", () => {
    // The message names the offending file, so a failure is actionable without
    // reading this test.
    expect(importers.filter((file) => !ALLOWED_IMPORTERS.has(file))).toEqual([]);
  });

  it.each(FORBIDDEN_SURFACES.map((surface) => [surface[0], surface[1]] as const))(
    "is not imported by %s",
    (_label, prefix) => {
      expect(importers.filter((file) => file.startsWith(prefix))).toEqual([]);
    },
  );

  it("scans both src/ and api/ when present", () => {
    expect(PRODUCTION_ROOTS).toContain("src");
    if (existsSync("api")) expect(PRODUCTION_ROOTS).toContain("api");
  });

  it("actually found the engine, so the check cannot pass vacuously", () => {
    const engineFiles = scanned.filter(({ file }) => file.startsWith(ENGINE_DIRECTORY));

    expect(engineFiles.length).toBeGreaterThanOrEqual(6);
  });

  it("detects a reference, so the check cannot pass by a broken pattern", () => {
    for (const reference of [
      `import { project } from "../units/project.js";`,
      `import { project } from "./units/project.js";`,
      `const engine = await import("../../src/units/project.js");`,
      `const engine = require("../units/format.js");`,
    ]) {
      expect(ENGINE_REFERENCE.test(reference)).toBe(true);
    }
  });

  it("does not mistake an unrelated path or a mention for an import", () => {
    for (const innocent of [
      `import { z } from "zod";`,
      `const note = "see src/units/project.ts for the conversion rules";`,
      `import { toAnyListRecipe } from "./anylist/mapping.js";`,
    ]) {
      expect(ENGINE_REFERENCE.test(innocent)).toBe(false);
    }
  });
});

describe("the engine does not drag production code in behind it", () => {
  const engineFiles = scanned.filter(({ file }) => file.startsWith(ENGINE_DIRECTORY));

  it("imports nothing from the rest of src/ at runtime", () => {
    // A runtime dependency on the recipe schema or the AnyList adapter would
    // make "dormant" a half-truth: loading the engine would load them too.
    const RUNTIME_OUTSIDE_IMPORT = /(?:^|\n)\s*import\s+(?!type\s)[^;]*from\s*["']\.\.\/(?!units\/)/;

    const offenders = engineFiles
      .filter(({ text }) => RUNTIME_OUTSIDE_IMPORT.test(text))
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  it("keeps its one link to the canonical schema type-only", () => {
    const bridge = engineFiles.find(
      ({ file }) => file === "src/units/canonical-compatibility.ts",
    );

    expect(bridge).toBeDefined();
    expect(bridge?.text).toContain('import type { Ingredient }');
  });

  it("has no I/O, no network, and no clock", () => {
    // A pure engine. Anything here would make the vectors untrustworthy as a
    // cross-language contract.
    for (const { file, text } of engineFiles) {
      if (file.endsWith(".test.ts")) continue;

      expect(text, file).not.toMatch(/\bfetch\s*\(|node:fs|node:http|Date\.now|Math\.random/);
    }
  });
});
