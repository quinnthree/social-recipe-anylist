import type { FastifyInstance } from "fastify";

import type { ClientCredentialStore } from "../../client/store.js";
import { mintCredential } from "../../client/token.js";
import type { RateLimitStore } from "../../ratelimit/store.js";
import { resolveClientIp, type ClientIpStrategy } from "../client-ip.js";
import { failWith } from "../errors.js";
import { registrationLimits, type LimitPolicy } from "../limits.js";
import { checkSchemaVersion, RegisterRequestSchema, SUPPORTED_SCHEMA_VERSION } from "../requests.js";
import { newDraft, STAGE_BY_KIND } from "../telemetry.js";

/** Registration bodies are one field. Nothing larger has any business arriving. */
export const REGISTER_BODY_LIMIT_BYTES = 1024;

/**
 * A collision is cryptographically improbable — 128 random bits — so a few
 * attempts is not a retry policy, it is a refusal to hand out a token whose
 * digest was never stored.
 */
const MINT_ATTEMPTS = 3;

export interface RegisterRouteDeps {
  clientStore: ClientCredentialStore | undefined;
  rateLimitStore: RateLimitStore | undefined;
  limits: LimitPolicy;
  ipStrategy: ClientIpStrategy;
  now: () => number;
}

/**
 * `POST /api/client/register` — the only route that mints a credential, and the
 * only one besides `/health` that requires none (ADR-026).
 *
 * Order is the security property here: every limit is consumed **before**
 * anything is minted. Minting first and refusing afterwards would leave a
 * credential nobody asked for behind every denied request, which is precisely
 * the orphan accumulation the limits exist to prevent.
 */
export function registerClientRegistrationRoute(
  server: FastifyInstance,
  deps: RegisterRouteDeps,
): void {
  server.post(
    "/api/client/register",
    { bodyLimit: REGISTER_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const draft = request.telemetry ?? newDraft("/api/client/register");
      request.telemetry = draft;
      const requestId = request.id;

      const reject = async (kind: Parameters<typeof failWith>[1]): Promise<void> => {
        draft.failureKind = kind;
        draft.failureStage = STAGE_BY_KIND[kind];
        await failWith(reply, kind, requestId);
      };

      const version = checkSchemaVersion(request.body);
      if (!version.ok) return reject(version.kind);

      if (!RegisterRequestSchema.safeParse(request.body).success) {
        return reject("invalid_body");
      }

      // No store, no registration. Minting a credential we cannot persist would
      // hand out a token that can never authenticate anything.
      if (deps.clientStore === undefined || deps.rateLimitStore === undefined) {
        request.log.error(
          { event: "registration.unavailable", hasClientStore: deps.clientStore !== undefined },
          "registration is not configured",
        );
        return reject("registration_failed");
      }

      const ip = resolveClientIp(
        { headers: request.headers, socketAddress: request.socket.remoteAddress },
        deps.ipStrategy,
      );

      // An unattributable request is refused, not exempted. Treating it as
      // unlimited would make "send no usable address" the way past the limit.
      if (ip === null) {
        request.log.warn({ event: "registration.unattributable" }, "registration without a client address");
        return reject("rate_limited");
      }

      const now = deps.now();

      let permitted;
      try {
        permitted = await deps.rateLimitStore.consume(
          registrationLimits(deps.limits, ip),
          now,
        );
      } catch {
        // Fail closed. A counter store that cannot answer is not permission.
        request.log.error({ event: "registration.limit_unavailable" }, "rate limit store failed");
        return reject("registration_failed");
      }

      if (!permitted.allowed) {
        // The scope, never the address: an IP is personal data and the scope is
        // what tells an operator which ceiling was met.
        request.log.warn(
          { event: "registration.rate_limited", scope: permitted.exceeded?.scope ?? null },
          "registration rate limited",
        );
        return reject("rate_limited");
      }

      try {
        for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt += 1) {
          const credential = mintCredential();

          const created = await deps.clientStore.create({
            clientId: credential.clientId,
            secretHash: credential.secretHash,
            createdAt: now,
          });

          if (created === "exists") continue;

          // clientId only. The token is a secret and this is the one place in
          // the system where a raw one exists.
          request.log.info(
            { event: "registration.completed", clientId: credential.clientId },
            "client registered",
          );

          draft.principalKind = "installation";
          draft.clientId = credential.clientId;

          return {
            success: true,
            schemaVersion: SUPPORTED_SCHEMA_VERSION,
            requestId,
            client: { id: credential.clientId, token: credential.token },
          };
        }

        request.log.error({ event: "registration.collision" }, "could not mint a fresh client id");
        return reject("registration_failed");
      } catch {
        request.log.error({ event: "registration.store_unavailable" }, "credential store failed");
        return reject("registration_failed");
      }
    },
  );
}
