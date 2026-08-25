import type { exportRecipe } from "../app/export-service.js";
import type { extractRecipe, importRecipe } from "../app/import-service.js";
import type { IdempotencyStore } from "../idempotency/store.js";
import type { AuthenticatedPrincipal } from "./principal.js";
import type { TelemetryDraft } from "./telemetry.js";

/**
 * Everything the routes need, injected rather than imported, so route tests
 * never touch TikTok, Anthropic, AnyList, or Redis.
 */
export interface RouteContext {
  extractRecipe: typeof extractRecipe;
  exportRecipe: typeof exportRecipe;
  /** The legacy one-shot pipeline, kept for `POST /api/import` and the CLI. */
  importRecipe: typeof importRecipe;
  idempotencyStore: IdempotencyStore;
  /** Injectable so lease expiry can be tested without waiting for it. */
  now: () => number;
  leaseMs: number;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Present on routed requests; absent on 404s and `/health`. */
    telemetry?: TelemetryDraft;
    /** Whether the request id was adopted from the client or issued by us. */
    requestIdSource?: "client" | "generated";
    /**
     * Who authenticated. Present only on requests that passed the auth hook,
     * so its absence on a protected route means the request never got in.
     *
     * Handlers do not read this today; it is the seam B3's quotas key on.
     */
    principal?: AuthenticatedPrincipal;
  }
}
