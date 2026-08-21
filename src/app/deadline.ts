/**
 * Thrown when an operation exceeded its budget.
 *
 * **A timeout is not cancellation.** `withTimeout` stops *waiting*; it has no
 * way to stop the work. For a `fetch` that distinction barely matters, because
 * the adapters pass their own `AbortSignal`. For the AnyList native client it
 * matters enormously: the library exposes no timeout option and no
 * `AbortSignal` on any method, so an abandoned `createRecipe` may still land in
 * the account seconds after we have already answered. That is why an export
 * timeout is `AMBIGUOUS` and never `FAILED_SAFE`.
 */
export class TimeoutError extends Error {
  constructor(readonly operation: string) {
    super(`${operation} exceeded its time budget.`);
    this.name = "TimeoutError";
  }
}

/**
 * Bounds a promise. Resolves with the work, or rejects with `TimeoutError`.
 *
 * The abandoned promise gets a no-op rejection handler so an eventual failure
 * on a result nobody is waiting for cannot surface as an unhandled rejection
 * and take the process down.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, operation: string): Promise<T> {
  if (ms <= 0) return Promise.reject(new TimeoutError(operation));

  work.catch(() => undefined);

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(operation)), ms);
    // unref, so a pending bound never keeps a CLI process alive past its work.
    timer.unref?.();

    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * A single wall-clock budget for one request, threaded through every step.
 *
 * The point is not to time each operation in isolation — it is that a step
 * never starts unless the *remaining* budget can accommodate it. That is what
 * stops a slow extraction from pushing the AnyList write into a window where it
 * is guaranteed to be abandoned, producing an ambiguous outcome we then have to
 * preserve for thirty days.
 */
export class Deadline {
  private constructor(
    private readonly expiresAt: number,
    private readonly clock: () => number,
  ) {}

  static after(ms: number, clock: () => number = Date.now): Deadline {
    return new Deadline(clock() + ms, clock);
  }

  remaining(): number {
    return Math.max(0, this.expiresAt - this.clock());
  }

  /** The smaller of a step's own budget and what is left of the request's. */
  budgetFor(stepMs: number): number {
    return Math.min(stepMs, this.remaining());
  }

  expired(): boolean {
    return this.remaining() <= 0;
  }
}
