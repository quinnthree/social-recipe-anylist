import type { ChildRequest, ChildResponse } from "../anylist/child-protocol.js";
import type { ChildRunner, RunnerFailure, RunnerOutcome } from "../anylist/child-runner.js";
import { emptyStderrReport } from "../anylist/stderr-scan.js";

/**
 * An in-process stand-in for the isolated AnyList child (ADR-023 containment).
 *
 * It reproduces the child's decision sequence — login, create, verify — and its
 * status-code extraction, so tests can express failures the way they always have
 * ("createRecipe throws a 500") while exercising the process-boundary protocol
 * rather than a native client. No process is spawned and no native module is
 * loaded, which is what keeps the adapter's tests fast and offline.
 *
 * The real child is covered separately by `src/anylist/child-runner.test.ts`,
 * which spawns actual processes.
 */

export interface FakeChildOptions {
  loginError?: unknown;
  createError?: unknown;
  verifyError?: unknown;
  /** What the read-back returns. Defaults to the created recipe. */
  verifyResult?: { id: string } | null;
  createdId?: string;
}

export interface FakeChildCalls {
  /** One per contained run: the real child logs in exactly once per operation. */
  login: number;
  create: number;
  verify: number;
  verifiedIds: string[];
  payloads: unknown[];
  requests: ChildRequest[];
}

const DEFAULT_CREATED_ID = "recipe-id-from-create";

/** The only provider-derived value the real child is allowed to pass across. */
function statusOf(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;

  const { response } = error as { response?: unknown };
  if (typeof response !== "object" || response === null) return null;

  const { statusCode } = response as { statusCode?: unknown };
  return typeof statusCode === "number" ? statusCode : null;
}

export function fakeChildRunner(options: FakeChildOptions = {}): {
  run: ChildRunner;
  calls: FakeChildCalls;
} {
  const createdId = options.createdId ?? DEFAULT_CREATED_ID;
  const calls: FakeChildCalls = {
    login: 0,
    create: 0,
    verify: 0,
    verifiedIds: [],
    payloads: [],
    requests: [],
  };

  const run: ChildRunner = (request) => {
    calls.requests.push(request);
    calls.login += 1;

    const respond = (response: ChildResponse): Promise<RunnerOutcome> =>
      Promise.resolve({ ok: true, response, stderr: emptyStderrReport(), elapsedMs: 0 });

    if (options.loginError !== undefined) {
      return respond({ ok: false, code: "login_failed", httpStatus: statusOf(options.loginError) });
    }

    calls.create += 1;
    calls.payloads.push(request.payload);

    if (options.createError !== undefined) {
      return respond({
        ok: false,
        code: "create_failed",
        httpStatus: statusOf(options.createError),
      });
    }

    calls.verify += 1;
    calls.verifiedIds.push(createdId);

    if (options.verifyError !== undefined) {
      return respond({
        ok: false,
        code: "verify_unreadable",
        httpStatus: statusOf(options.verifyError),
      });
    }

    const stored = options.verifyResult === undefined ? { id: createdId } : options.verifyResult;
    if (!stored || stored.id !== createdId) {
      return respond({ ok: false, code: "verify_missing", httpStatus: null });
    }

    return respond({ ok: true, identifier: createdId });
  };

  return { run, calls };
}

/** A runner whose child never produced a usable answer. */
export function failingChildRunner(failure: RunnerFailure): ChildRunner {
  return () => Promise.resolve({ ok: false, failure, stderr: emptyStderrReport(), elapsedMs: 0 });
}

/** A runner whose child answered with a specific protocol response. */
export function respondingChildRunner(response: ChildResponse): ChildRunner {
  return () => Promise.resolve({ ok: true, response, stderr: emptyStderrReport(), elapsedMs: 0 });
}
