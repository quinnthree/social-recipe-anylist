import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { LazyIdempotencyStore } from "../idempotency/lazy-store.js";
import { MemoryIdempotencyStore } from "../idempotency/memory-store.js";
import {
  hasRedisConfiguration,
  MEMORY_STORE_WARNING,
  REDIS_REQUIRED,
  resolveHost,
  redisCredentialSource,
  resolveIdempotencyStore,
  resolvePort,
} from "./runtime.js";

const REDIS = { KV_REST_API_URL: "https://x.upstash.io", KV_REST_API_TOKEN: "token" };

describe("resolveHost", () => {
  it("binds loopback locally", () => {
    expect(resolveHost({})).toBe("127.0.0.1");
  });

  it("binds all interfaces on Vercel, which proxies over an internal port", () => {
    expect(resolveHost({ VERCEL: "1" })).toBe("0.0.0.0");
  });

  it("honours an explicit HOST in either environment", () => {
    expect(resolveHost({ HOST: "0.0.0.0" })).toBe("0.0.0.0");
    expect(resolveHost({ VERCEL: "1", HOST: "127.0.0.1" })).toBe("127.0.0.1");
  });

  it("ignores a blank HOST rather than binding to nothing", () => {
    expect(resolveHost({ HOST: "   " })).toBe("127.0.0.1");
  });
});

describe("resolvePort", () => {
  it("defaults to 3000", () => {
    expect(resolvePort({})).toBe(3000);
  });

  it("uses the platform-supplied port", () => {
    expect(resolvePort({ PORT: "8080" })).toBe(8080);
  });

  it("falls back rather than binding NaN", () => {
    expect(resolvePort({ PORT: "not-a-number" })).toBe(3000);
  });
});

describe("hasRedisConfiguration", () => {
  it("accepts the KV_ naming", () => {
    expect(hasRedisConfiguration(REDIS)).toBe(true);
  });

  it("accepts the UPSTASH_ naming, because the integration has used both", () => {
    expect(
      hasRedisConfiguration({
        UPSTASH_REDIS_REST_URL: "https://x.upstash.io",
        UPSTASH_REDIS_REST_TOKEN: "token",
      }),
    ).toBe(true);
  });

  it("requires both halves", () => {
    expect(hasRedisConfiguration({ KV_REST_API_URL: "https://x.upstash.io" })).toBe(false);
    expect(hasRedisConfiguration({ KV_REST_API_TOKEN: "token" })).toBe(false);
  });
});

describe("redisCredentialSource", () => {
  it("accepts the pair Vercel actually provisioned", () => {
    // The deployed environment supplies UPSTASH_REDIS_REST_URL and
    // UPSTASH_REDIS_REST_TOKEN. These exact names must keep resolving.
    expect(
      redisCredentialSource({
        UPSTASH_REDIS_REST_URL: "https://x.upstash.io",
        UPSTASH_REDIS_REST_TOKEN: "token",
      }),
    ).toBe("UPSTASH_REDIS_REST_*");
  });

  it("accepts the KV_ alias pair", () => {
    expect(redisCredentialSource(REDIS)).toBe("KV_REST_API_*");
  });

  it("prefers KV_ when both are present, matching the per-variable lookup", () => {
    expect(
      redisCredentialSource({
        ...REDIS,
        UPSTASH_REDIS_REST_URL: "https://y.upstash.io",
        UPSTASH_REDIS_REST_TOKEN: "other",
      }),
    ).toBe("KV_REST_API_*");
  });

  it("reports nothing when neither pair is complete", () => {
    expect(redisCredentialSource({ UPSTASH_REDIS_REST_URL: "https://x.upstash.io" })).toBeNull();
    expect(redisCredentialSource({})).toBeNull();
  });

  it("names both accepted pairs when refusing to deploy", () => {
    // The operator who hits this needs to know which variables to set, and the
    // provisioned pair is the UPSTASH_ one.
    expect(REDIS_REQUIRED).toContain("UPSTASH_REDIS_REST_URL");
    expect(REDIS_REQUIRED).toContain("KV_REST_API_URL");
  });

  it("ignores REDIS_URL, which the application does not use", () => {
    expect(redisCredentialSource({ REDIS_URL: "redis://x" })).toBeNull();
  });
});

describe("resolveIdempotencyStore", () => {
  it("uses the UPSTASH_ pair on Vercel without falling back to memory", () => {
    const store = resolveIdempotencyStore(
      {
        VERCEL: "1",
        UPSTASH_REDIS_REST_URL: "https://x.upstash.io",
        UPSTASH_REDIS_REST_TOKEN: "token",
      },
      () => undefined,
    );

    expect(store).toBeInstanceOf(LazyIdempotencyStore);
    expect(store).not.toBeInstanceOf(MemoryIdempotencyStore);
  });

  it("uses Redis when it is configured", () => {
    expect(resolveIdempotencyStore(REDIS, () => undefined)).toBeInstanceOf(LazyIdempotencyStore);
  });

  it("refuses to deploy without a durable store", () => {
    // An in-process store on Vercel is worse than none: it presents a
    // duplicate-prevention guarantee it cannot keep.
    expect(() => resolveIdempotencyStore({ VERCEL: "1" }, () => undefined)).toThrow(REDIS_REQUIRED);
  });

  it("still refuses when only half the configuration is present", () => {
    expect(() =>
      resolveIdempotencyStore({ VERCEL: "1", KV_REST_API_URL: "https://x.upstash.io" }, () => undefined),
    ).toThrow(REDIS_REQUIRED);
  });

  it("falls back locally, and says so", () => {
    const warn = vi.fn();

    expect(resolveIdempotencyStore({}, warn)).toBeInstanceOf(MemoryIdempotencyStore);
    expect(warn).toHaveBeenCalledWith(MEMORY_STORE_WARNING);
  });

  it("does not put credentials in the refusal message", () => {
    const error = (() => {
      try {
        resolveIdempotencyStore({ VERCEL: "1", KV_REST_API_TOKEN: "super-secret" }, () => undefined);
        return null;
      } catch (thrown: unknown) {
        return thrown;
      }
    })();

    expect(String(error)).not.toContain("super-secret");
  });
});

describe("LazyIdempotencyStore", () => {
  it("builds the real store only on first use", async () => {
    const build = vi.fn(async () => new MemoryIdempotencyStore());
    const store = new LazyIdempotencyStore(build);

    expect(build).not.toHaveBeenCalled();

    await store.read("k");
    await store.read("k");

    // Memoised: concurrent first requests share one client.
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("does not cache a construction failure", async () => {
    let attempt = 0;
    const store = new LazyIdempotencyStore(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("transient");
      return new MemoryIdempotencyStore();
    });

    await expect(store.read("k")).rejects.toThrow("transient");
    await expect(store.read("k")).resolves.toBeNull();
  });
});

/**
 * Vercel's own Fastify entrypoint detector, copied verbatim from
 * `@vercel/fastify`'s call into `generateNodeBuilderFunctions`.
 *
 * The builder globs the candidates below, reads each file, and takes the
 * **first whose text matches this regex**. Filename order alone decides
 * nothing. Encoding the real rule here means a change that would break the
 * deploy breaks the suite first.
 */
const FASTIFY_ENTRYPOINT = /(?:from|require|import)\s*(?:\(\s*)?["']fastify["']\s*(?:\))?/;

const CANDIDATE_PATHS = ["app", "index", "server", "src/app", "src/index", "src/server"].flatMap(
  (name) => ["js", "cjs", "mjs", "ts", "cts", "mts"].map((ext) => `${name}.${ext}`),
);

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

describe("Vercel Fastify entrypoint detection", () => {
  const matching = CANDIDATE_PATHS.filter((path) => {
    const source = readIfPresent(path);
    return source !== null && FASTIFY_ENTRYPOINT.test(source);
  });

  it("has exactly one candidate that matches", () => {
    // Zero matches means no Fastify entrypoint is found and the build falls
    // back to expecting an `api/` directory. More than one makes the builder
    // warn and pick by a list order we do not control.
    expect(matching).toEqual(["src/app.ts"]);
  });

  it("does not let the CLI become the entrypoint", () => {
    const cli = readIfPresent("src/index.ts") ?? "";

    // src/index.ts is a candidate path and never calls listen(). It must not
    // mention fastify, or it could be selected and the deployment would come up
    // with no HTTP server.
    expect(FASTIFY_ENTRYPOINT.test(cli)).toBe(false);
  });

  it("keeps fastify a direct dependency, which detection also requires", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      dependencies: Record<string, string>;
    };

    expect(pkg.dependencies["fastify"]).toBeDefined();
  });
});

describe("Vercel function configuration", () => {
  const entrypoint = readFileSync("src/app.ts", "utf8");
  const vercelConfig = JSON.parse(readFileSync("vercel.json", "utf8")) as Record<string, unknown>;

  it("sets maxDuration in the entrypoint's static config", () => {
    // `@vercel/node` reads `export const config` from the resolved entrypoint
    // via `@vercel/static-config` and uses `maxDuration` for the function.
    expect(entrypoint).toMatch(/export const config = \{ maxDuration: 120 \}/);
  });

  it("keeps that config an object literal, because it is parsed and not evaluated", () => {
    expect(entrypoint).not.toMatch(/export const config = [A-Za-z_]/);
  });

  it("defines no `functions` block", () => {
    // A `functions` pattern is validated against Serverless Functions in `api/`.
    // For a framework-detected backend it matches nothing and fails the build
    // with "doesn't match any Serverless Functions inside the `api` directory".
    expect(vercelConfig["functions"]).toBeUndefined();
  });

  it("pins the framework and the region", () => {
    expect(vercelConfig["framework"]).toBe("fastify");
    expect(vercelConfig["regions"]).toEqual(["iad1"]);
  });
});

describe("deployment entrypoint", () => {
  it("builds through the shared factory rather than restating the wiring", () => {
    // Both entrypoints call createServer(); only the local one listens.
    expect(readFileSync("src/app.ts", "utf8")).toContain("createServer()");
    expect(readFileSync("src/server.ts", "utf8")).toContain("createServer()");
  });

  it("listens at module load in the local entrypoint only", () => {
    const local = readFileSync("src/server.ts", "utf8");

    expect(local).toContain(".listen(");
    // A `process.argv[1]` guard would make `npm run server` depend on how the
    // file happened to be invoked.
    expect(local).not.toContain("pathToFileURL");
  });

  it("keeps the local scripts pointed at the same entrypoint", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
      engines?: { node?: string };
    };

    expect(pkg.scripts["server"]).toBe("tsx src/server.ts");
    expect(pkg.scripts["server:dev"]).toBe("tsx watch src/server.ts");
    expect(pkg.engines?.node).toBe("22.x");
  });

  it("pins the native AnyList package exactly", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      dependencies: Record<string, string>;
    };

    // One maintainer, one published version, an unauditable binary: a caret
    // would silently accept a future publish.
    expect(pkg.dependencies["@anylist-napi/anylist-napi"]).toBe("1.1.1");
  });

  it("resolves @types/node from a tsconfig that lives outside this project", () => {
    // Vercel's Node builder transpiles by writing a tsconfig into a temp
    // directory that `extends` ours. The default typeRoots are then searched
    // from that temp directory, which never reaches this project's
    // node_modules/@types, and the build fails with:
    //   TS2688: Cannot find type definition file for 'node'
    // An explicit typeRoots is resolved relative to the file that declares it,
    // so it keeps pointing here no matter who extends it.
    const tsconfig = readFileSync("tsconfig.json", "utf8");

    expect(tsconfig).toMatch(/"typeRoots"\s*:\s*\[\s*"\.\/node_modules\/@types"\s*\]/);
    expect(tsconfig).toMatch(/"types"\s*:\s*\[\s*"node"\s*\]/);
  });

  it("keeps the Node type definitions on the same major as the runtime", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      devDependencies: Record<string, string>;
      engines?: { node?: string };
    };

    // Types for a newer Node than we run would typecheck against APIs that are
    // absent at runtime.
    const runtimeMajor = pkg.engines?.node?.replace(/\D.*$/, "");
    expect(pkg.devDependencies["@types/node"]).toMatch(new RegExp(`^\\^?${runtimeMajor}\\.`));
  });

  it("keeps the Linux x64 gnu binary in the lockfile for a fresh Linux install", () => {
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
      packages: Record<string, unknown>;
    };

    // includeFiles is not available to a framework-detected backend, so the
    // binary reaching the bundle depends on the lockfile resolving it and on
    // node-file-trace following the loader's static requires.
    expect(lock.packages["node_modules/@anylist-napi/anylist-napi-linux-x64-gnu"]).toBeDefined();
  });
});
