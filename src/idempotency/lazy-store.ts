import type {
  ClaimRequest,
  ClaimResult,
  IdempotencyRecord,
  IdempotencyStore,
  StoredResult,
} from "./store.js";

/**
 * Defers building the real store until the first export request.
 *
 * The server entrypoint must call `listen()` promptly — Vercel detects the HTTP
 * server from that call — so the process should not be awaiting a client
 * constructor before it can accept traffic. Configuration is still validated
 * eagerly at startup (see `src/server.ts`); only the client construction is
 * deferred, and the promise is memoised so concurrent first requests share one
 * client.
 */
export class LazyIdempotencyStore implements IdempotencyStore {
  private resolved: Promise<IdempotencyStore> | null = null;

  constructor(private readonly build: () => Promise<IdempotencyStore>) {}

  private store(): Promise<IdempotencyStore> {
    if (this.resolved === null) {
      this.resolved = this.build().catch((error: unknown) => {
        // Do not cache a failure: a transient construction problem should not
        // disable idempotency for the life of the instance.
        this.resolved = null;
        throw error;
      });
    }

    return this.resolved;
  }

  async claim(request: ClaimRequest): Promise<ClaimResult> {
    return (await this.store()).claim(request);
  }

  async complete(key: string, requestId: string, result: StoredResult, now: number): Promise<void> {
    return (await this.store()).complete(key, requestId, result, now);
  }

  async fail(
    key: string,
    requestId: string,
    state: "FAILED_SAFE" | "AMBIGUOUS",
    failureCode: string,
    now: number,
  ): Promise<void> {
    return (await this.store()).fail(key, requestId, state, failureCode, now);
  }

  async read(key: string): Promise<IdempotencyRecord | null> {
    return (await this.store()).read(key);
  }
}
