import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { LazyIdempotencyStore } from "../idempotency/lazy-store.js";
import { MemoryIdempotencyStore } from "../idempotency/memory-store.js";
import {
  hasRedisConfiguration,
  MEMORY_STORE_WARNING,
  REDIS_REQUIRED,
  resolveHost,
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

describe("resolveIdempotencyStore", () => {
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
 * The deployment configuration is as load-bearing as the code, and it is not
 * exercised by anything else in the suite. These assertions are cheap and they
 * catch the mistakes that would only otherwise surface as a failed deploy.
 */
describe("Vercel configuration", () => {
  const config = JSON.parse(readFileSync("vercel.json", "utf8")) as {
    framework?: string;
    functions?: Record<string, { maxDuration?: number; includeFiles?: string }>;
  };

  it("pins the Fastify framework rather than relying on inference", () => {
    expect(config.framework).toBe("fastify");
  });

  it("requests a 120 second maximum duration for the entrypoint", () => {
    for (const entry of Object.values(config.functions ?? {})) {
      expect(entry.maxDuration).toBe(120);
    }
  });

  it("includes the AnyList native binary, which tracing must not drop", () => {
    for (const entry of Object.values(config.functions ?? {})) {
      expect(entry.includeFiles).toBe("node_modules/@anylist-napi/**");
    }
  });

  it("covers the entrypoint Vercel will actually select", () => {
    // Vercel checks src/app, then src/index, then src/server. src/index.ts is
    // our CLI and never calls listen(), so src/app.ts claims the first slot.
    expect(Object.keys(config.functions ?? {})).toContain("src/app.ts");
  });
});

describe("deployment entrypoint", () => {
  it("exists at the highest-priority location Vercel checks", () => {
    const entry = readFileSync("src/app.ts", "utf8");

    expect(entry).toContain('import "./server.js"');
  });

  it("duplicates no wiring: it only imports the local entrypoint", () => {
    const entry = readFileSync("src/app.ts", "utf8");
    const statements = entry
      .split("\n")
      .filter((line) => line.trim().length > 0 && !line.trim().startsWith("*") && !line.trim().startsWith("/*"));

    expect(statements).toEqual(['import "./server.js";']);
  });

  it("calls listen at module load, which is how Vercel detects the server", () => {
    const server = readFileSync("src/server.ts", "utf8");

    expect(server).toContain("server.listen(");
    // A `process.argv[1]` guard would make detection depend on how the file
    // happened to be invoked.
    expect(server).not.toContain("pathToFileURL");
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

  it("keeps the Linux x64 gnu binary in the lockfile for a fresh Linux install", () => {
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
      packages: Record<string, unknown>;
    };

    expect(lock.packages["node_modules/@anylist-napi/anylist-napi-linux-x64-gnu"]).toBeDefined();
  });
});
