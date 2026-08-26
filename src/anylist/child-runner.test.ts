import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createChildRunner } from "./child-runner.js";

/**
 * The containment boundary, exercised against **real spawned processes**.
 *
 * A stubbed runner cannot prove any of this: the properties under test are
 * about pipes, exit codes, signals, and a file descriptor the parent does not
 * control. So these tests start actual children.
 *
 * The stand-in plants fixed synthetic cookie, bearer, and JWT-shaped values on
 * its stderr. Every assertion here is that none of it survives the boundary —
 * and the assertions themselves are written to never reproduce it either.
 */

const ENTRY = "tests/support/anylist-children/scripted-child.mjs";
const REQUEST = { operation: "save", payload: { name: "Test" } } as const;

/** Substrings of the planted material. Present only so we can assert absence. */
const PLANTED_MARKERS = [
  "planted-cookie-value",
  "planted-bearer-token-value",
  "PLANTED_SESSION",
  "cGxhbnRlZC1zaWduYXR1cmU",
];

function runnerFor(script: string, timeoutMs = 15_000) {
  vi.stubEnv("CHILD_SCRIPT", script);

  return createChildRunner({ entry: ENTRY, timeoutMs });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the happy path", () => {
  it("returns the child's response", async () => {
    const outcome = await runnerFor("success")(REQUEST);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.response).toEqual({ ok: true, identifier: "child-identifier" });
  });

  it("passes a protocol failure through unchanged", async () => {
    const outcome = await runnerFor("failure")(REQUEST);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.response).toEqual({ ok: false, code: "create_failed", httpStatus: 500 });
    }
  });
});

describe("transport failures are classified, never propagated", () => {
  it.each([
    ["a child that exits non-zero", "crash", "child_crashed"],
    ["stdout that is not JSON", "malformed", "malformed_stdout"],
    ["a response outside the closed schema", "bad_schema", "malformed_stdout"],
    ["an unrecognised failure code", "unknown_code", "malformed_stdout"],
    ["more than one message", "multi", "malformed_stdout"],
    ["trailing output after a valid message", "trailing", "malformed_stdout"],
    ["stdout beyond the ceiling", "oversized", "oversized_stdout"],
  ])("reports %s as %s", async (_label, script, expected) => {
    const outcome = await runnerFor(script)(REQUEST);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure).toBe(expected);
  });

  it("reports a child that cannot be started", async () => {
    const outcome = await createChildRunner({ entry: "/nonexistent/child.mjs" })(REQUEST);

    expect(outcome.ok).toBe(false);
    // Node reports a missing script through a non-zero exit rather than a spawn
    // error, and either way the parent must not treat it as a usable answer.
    if (!outcome.ok) expect(["spawn_failed", "child_crashed"]).toContain(outcome.failure);
  });
});

describe("timeouts terminate and reap the child", () => {
  it("times out rather than waiting forever", async () => {
    const outcome = await runnerFor("hang", 400)(REQUEST);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure).toBe("timeout");
  });

  it("leaves no orphan behind", async () => {
    const pidFile = join(tmpdir(), `m6b-child-pid-${process.pid}-${Math.trunc(performance.now())}`);
    vi.stubEnv("CHILD_PID_FILE", pidFile);

    await runnerFor("hang", 400)(REQUEST);

    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    rmSync(pidFile, { force: true });

    // `kill(pid, 0)` tests for existence without signalling. The runner awaits
    // `close`, which fires after the process is reaped, so by here it is gone.
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe("stderr never escapes the boundary", () => {
  it("reports planted material by category, and returns none of it", async () => {
    const outcome = await runnerFor("leaky")(REQUEST);

    expect(outcome.ok).toBe(true);
    expect(outcome.stderr.prohibited).toBe(true);
    expect(outcome.stderr.setCookie).toBeGreaterThan(0);
    expect(outcome.stderr.jwtLike).toBeGreaterThan(0);
    expect(outcome.stderr.bearerToken).toBeGreaterThan(0);

    // The entire outcome, serialised. Nothing planted may appear anywhere in it.
    const serialised = JSON.stringify(outcome);
    for (const marker of PLANTED_MARKERS) expect(serialised).not.toContain(marker);
  });

  it("still succeeds: a noisy child is not a failed one", async () => {
    const outcome = await runnerFor("leaky")(REQUEST);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.response).toEqual({ ok: true, identifier: "child-identifier" });
  });

  it("truncates an overflowing stderr without leaking through the overflow path", async () => {
    const outcome = await runnerFor("stderr_flood")(REQUEST);

    expect(outcome.stderr.truncated).toBe(true);
    // Retention is bounded, so the report cannot grow with the child's output.
    expect(outcome.stderr.bytes).toBeLessThanOrEqual(64 * 1024);

    const serialised = JSON.stringify(outcome);
    for (const marker of PLANTED_MARKERS) expect(serialised).not.toContain(marker);
  });

  it("keeps draining, so a flooding child still completes", async () => {
    // If the parent stopped reading at the ceiling, the pipe would fill and the
    // child would block mid-write and never answer.
    const outcome = await runnerFor("stderr_flood")(REQUEST);

    expect(outcome.ok).toBe(true);
  });

  it("attaches nothing to a thrown error, because it throws none", async () => {
    // The runner reports failures as values. There is no error object for
    // captured output to ride out on.
    const outcome = await runnerFor("crash")(REQUEST);

    expect(outcome).not.toBeInstanceOf(Error);
    expect(JSON.stringify(outcome)).not.toContain("planted");
  });
});

describe("the real child, without credentials", () => {
  it("reports missing credentials without loading the native module", async () => {
    vi.stubEnv("ANYLIST_EMAIL", "");
    vi.stubEnv("ANYLIST_PASSWORD", "");

    // The real entrypoint. It checks credentials before importing anything
    // native, so this neither loads the binary nor reaches the network.
    const outcome = await createChildRunner()(REQUEST);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.response).toEqual({
        ok: false,
        code: "missing_credentials",
        httpStatus: null,
      });
    }
  });
});
