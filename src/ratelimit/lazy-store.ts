import type { ConsumeResult, LimitDescriptor, RateLimitStore } from "./store.js";

/** Defers building the real store until the first limited request. */
export class LazyRateLimitStore implements RateLimitStore {
  private resolved: Promise<RateLimitStore> | null = null;

  constructor(private readonly build: () => Promise<RateLimitStore>) {}

  private store(): Promise<RateLimitStore> {
    if (this.resolved === null) {
      this.resolved = this.build().catch((error: unknown) => {
        this.resolved = null;
        throw error;
      });
    }

    return this.resolved;
  }

  async consume(descriptors: readonly LimitDescriptor[], now: number): Promise<ConsumeResult> {
    return (await this.store()).consume(descriptors, now);
  }
}
