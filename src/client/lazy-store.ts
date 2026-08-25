import type {
  CleanupResult,
  ClientCredential,
  ClientCredentialStore,
  CreateResult,
  NewClientCredential,
  RevokeResult,
  TouchResult,
} from "./store.js";

/**
 * Defers building the real credential store until the first request that needs
 * one, mirroring `LazyIdempotencyStore`.
 *
 * The server entrypoint must call `listen()` promptly — Vercel detects the HTTP
 * server from that call — so the process should not be awaiting a client
 * constructor before it can accept traffic. Requests authenticated with the
 * internal key never reach this at all.
 */
export class LazyClientCredentialStore implements ClientCredentialStore {
  private resolved: Promise<ClientCredentialStore> | null = null;

  constructor(private readonly build: () => Promise<ClientCredentialStore>) {}

  private store(): Promise<ClientCredentialStore> {
    if (this.resolved === null) {
      this.resolved = this.build().catch((error: unknown) => {
        // Do not cache a failure: a transient construction problem should not
        // disable consumer authentication for the life of the instance.
        this.resolved = null;
        throw error;
      });
    }

    return this.resolved;
  }

  async create(record: NewClientCredential): Promise<CreateResult> {
    return (await this.store()).create(record);
  }

  async read(clientId: string): Promise<ClientCredential | null> {
    return (await this.store()).read(clientId);
  }

  async touch(clientId: string, now: number, refreshAfterMs?: number): Promise<TouchResult> {
    return (await this.store()).touch(clientId, now, refreshAfterMs);
  }

  async revoke(clientId: string, now: number): Promise<RevokeResult> {
    return (await this.store()).revoke(clientId, now);
  }

  async deleteIfUnused(
    clientId: string,
    now: number,
    olderThanMs?: number,
  ): Promise<CleanupResult> {
    return (await this.store()).deleteIfUnused(clientId, now, olderThanMs);
  }
}
