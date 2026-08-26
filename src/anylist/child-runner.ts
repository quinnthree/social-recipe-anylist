import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseChildResponse, type ChildRequest, type ChildResponse } from "./child-protocol.js";
import { emptyStderrReport, scanStderr, type StderrReport } from "./stderr-scan.js";

/**
 * Runs one AnyList operation in an isolated child process (ADR-023).
 *
 * The native library writes response metadata — including `set-cookie` — to file
 * descriptor 2 from Rust, below anything JavaScript can intercept. The only
 * lever an application has over a descriptor it cannot patch is to own it, so
 * the call happens in a child whose stderr is a pipe this module holds, scans,
 * and drops.
 *
 * Every rule below is load-bearing:
 *
 * - **`spawn`, never `exec`.** `exec` buffers stderr and attaches it to the
 *   error it throws, which would hand the leaked bytes to whatever catches —
 *   exactly the outcome this boundary exists to prevent.
 * - **stderr is `"pipe"`, never `"inherit"`.** `inherit` would give the child
 *   our own descriptor, which on a deployed host is the platform log.
 * - **The pipe is drained even after the retention ceiling is reached.** A
 *   reader that stops reading fills the pipe buffer and blocks the child
 *   mid-write; retention and drainage are therefore separate concerns.
 * - **Raw stderr is discarded at a single point above every return.** Timeout,
 *   crash, malformed output, and success all pass through it, so no termination
 *   mode can surface what another would not.
 */

/** Retained for scanning. The pipe keeps draining past this; only retention stops. */
const MAX_RETAINED_STDERR_BYTES = 64 * 1024;

/** A child that talks this much on stdout is not speaking our protocol. */
const MAX_STDOUT_BYTES = 64 * 1024;

/**
 * A hard backstop, deliberately **longer** than the export deadline
 * (`DEFAULT_EXPORT_TIMEOUT_MS`, 90 s).
 *
 * Ordering matters for behaviour preservation: the export-level timeout must
 * still be the one that fires on a slow AnyList, so a slow save keeps reporting
 * `export_timeout` exactly as it did before this milestone. This timer exists to
 * guarantee the child is always killed and reaped rather than to classify
 * anything — before containment there was no way to stop the work at all
 * (see `app/deadline.ts`), and now there is.
 */
export const CHILD_BACKSTOP_TIMEOUT_MS = 100_000;

/** Why the child produced no usable answer. A closed set, chosen by us. */
export type RunnerFailure =
  | "spawn_failed"
  | "timeout"
  | "child_crashed"
  | "malformed_stdout"
  | "oversized_stdout";

export type RunnerOutcome =
  | { ok: true; response: ChildResponse; stderr: StderrReport; elapsedMs: number }
  | { ok: false; failure: RunnerFailure; stderr: StderrReport; elapsedMs: number };

/** Injectable so the adapter's tests never spawn anything. */
export type ChildRunner = (request: ChildRequest) => Promise<RunnerOutcome>;

const CHILD_RELATIVE_PATH = "src/anylist/child/anylist-child.mjs";

/**
 * Locates the child entrypoint.
 *
 * `process.cwd()` first, because that is what resolves inside a deployed
 * function, where the TypeScript around this file has been bundled and only the
 * explicitly-included child survives as a real file. The module-relative path is
 * the local-development answer, where nothing is bundled. The environment
 * override exists for tests.
 */
export function resolveChildEntry(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["ANYLIST_CHILD_ENTRY"];
  if (override !== undefined && override.length > 0) return override;

  const fromCwd = join(process.cwd(), CHILD_RELATIVE_PATH);
  if (existsSync(fromCwd)) return fromCwd;

  return join(dirname(fileURLToPath(import.meta.url)), "child", "anylist-child.mjs");
}

export function createChildRunner(
  options: { entry?: string; timeoutMs?: number } = {},
): ChildRunner {
  const entry = options.entry ?? resolveChildEntry();
  const timeoutMs = options.timeoutMs ?? CHILD_BACKSTOP_TIMEOUT_MS;

  return (request) => runInChild(request, entry, timeoutMs);
}

async function runInChild(
  request: ChildRequest,
  entry: string,
  timeoutMs: number,
): Promise<RunnerOutcome> {
  const startedAt = process.hrtime.bigint();
  const elapsed = (): number => Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);

  let child;
  try {
    child = spawn(process.execPath, [entry], {
      // stdin carries the request, stdout the narrow reply, stderr is ours to
      // swallow. Nothing is inherited.
      stdio: ["pipe", "pipe", "pipe"],
      // The child reads ANYLIST_EMAIL / ANYLIST_PASSWORD from here, which is
      // what keeps credentials out of both argv and the request protocol.
      env: process.env,
    });
  } catch {
    return { ok: false, failure: "spawn_failed", stderr: emptyStderrReport(), elapsedMs: elapsed() };
  }

  let retainedStderr = "";
  let stderrTruncated = false;
  let stdout = "";
  let stdoutOverflowed = false;

  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");

  child.stderr.on("data", (chunk: string) => {
    // Keep consuming regardless: a full pipe would stall the child mid-write.
    if (retainedStderr.length >= MAX_RETAINED_STDERR_BYTES) {
      stderrTruncated = true;
      return;
    }
    retainedStderr += chunk;
    if (retainedStderr.length > MAX_RETAINED_STDERR_BYTES) {
      retainedStderr = retainedStderr.slice(0, MAX_RETAINED_STDERR_BYTES);
      stderrTruncated = true;
    }
  });

  child.stdout.on("data", (chunk: string) => {
    if (stdoutOverflowed) return;
    stdout += chunk;
    // Checked after appending: a single oversized chunk must trip this too.
    if (stdout.length > MAX_STDOUT_BYTES) {
      stdoutOverflowed = true;
      stdout = "";
    }
  });

  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify(request));

  let timedOut = false;
  let spawnFailed = false;

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);

  // `close` rather than `exit`: it fires once the stdio streams have also ended,
  // so nothing the child wrote can arrive after the decision is made.
  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("error", () => {
      spawnFailed = true;
      resolve(null);
    });
    child.on("close", (code) => resolve(code));
  });

  clearTimeout(timer);

  // ── The single discard point. Every return below is downstream of it. ──
  const stderr = scanStderr(retainedStderr, stderrTruncated);
  retainedStderr = "";

  const failWith = (failure: RunnerFailure): RunnerOutcome => ({
    ok: false,
    failure,
    stderr,
    elapsedMs: elapsed(),
  });

  if (spawnFailed) return failWith("spawn_failed");
  if (timedOut) return failWith("timeout");
  if (stdoutOverflowed) return failWith("oversized_stdout");
  if (exitCode !== 0) return failWith("child_crashed");

  const response = readSingleResponse(stdout);
  if (response === null) return failWith("malformed_stdout");

  return { ok: true, response, stderr, elapsedMs: elapsed() };
}

/**
 * Reads exactly one protocol message.
 *
 * Multiple messages, trailing output, or anything outside the closed schema is a
 * failure rather than a best-effort read. A child that said more than one thing
 * is a child we do not understand, and picking one of its statements would be a
 * guess about which.
 */
function readSingleResponse(stdout: string): ChildResponse | null {
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length !== 1) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(lines[0] as string);
  } catch {
    return null;
  }

  return parseChildResponse(parsed);
}
