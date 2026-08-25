import type { ClientCredentialStore } from "../client/store.js";
import { parseToken, verifySecret } from "../client/token.js";
import { isAuthorized, readBearer } from "./auth.js";

/**
 * Who is calling (ADR-026).
 *
 * Route handlers never see a token. They do not, today, see this either — it
 * exists so that quotas, revocation, and any future attachment of an
 * installation to a signed-in user have something to key on without any of them
 * reparsing a credential.
 */
export type AuthenticatedPrincipal =
  | { kind: "internal" }
  | { kind: "installation"; clientId: string };

/**
 * Three outcomes, deliberately distinct.
 *
 * `unauthorized` is a statement about the credential. `unavailable` is a
 * statement about us: the credential could not be checked at all. Collapsing
 * them would mean answering 401 during a store outage, and the iOS client
 * treats 401 as "discard the credential and register again" — so an outage
 * would destroy every working credential and stampede the registration endpoint
 * at the worst possible moment.
 */
export type PrincipalResolution =
  | { outcome: "authenticated"; principal: AuthenticatedPrincipal }
  | { outcome: "unauthorized" }
  | { outcome: "unavailable" };

const UNAUTHORIZED: PrincipalResolution = { outcome: "unauthorized" };

export interface ResolvePrincipalOptions {
  header: string | undefined;
  internalSecret: string;
  /** Absent where consumer authentication is not configured for this deployment. */
  clientStore: ClientCredentialStore | undefined;
  now: number;
}

/**
 * Resolve an `Authorization` header to a principal.
 *
 * Order matters and is contractual (`contracts.md` Part 3): the internal key is
 * checked first and never touches the store, so CLI and smoke traffic pay none
 * of the consumer path's latency, and a malformed installation token is
 * rejected before a lookup rather than after one.
 *
 * Nothing here distinguishes its failures to the caller beyond the three
 * outcomes above. An unknown client, a wrong secret, and a revoked record are
 * the same answer on purpose — a client that could tell them apart could
 * enumerate valid client ids.
 */
export async function resolvePrincipal({
  header,
  internalSecret,
  clientStore,
  now,
}: ResolvePrincipalOptions): Promise<PrincipalResolution> {
  if (isAuthorized(header, internalSecret)) {
    return { outcome: "authenticated", principal: { kind: "internal" } };
  }

  const bearer = readBearer(header);
  if (bearer === null) return UNAUTHORIZED;

  const token = parseToken(bearer);
  if (token === null) return UNAUTHORIZED;

  // Structurally valid but nowhere to check it. Not an outage — this
  // deployment simply does not offer consumer authentication.
  if (clientStore === undefined) return UNAUTHORIZED;

  try {
    const record = await clientStore.read(token.clientId);

    if (record === null) return UNAUTHORIZED;
    if (record.status !== "active") return UNAUTHORIZED;
    if (!verifySecret(token.secret, record.secretHash)) return UNAUTHORIZED;

    // Only now, after the secret has actually authenticated. A failed
    // verification must leave no trace on the record — otherwise a wrong secret
    // would mark a credential as "in use" and keep an orphan alive.
    //
    // `touch` is atomic and is the final authority: if the credential was
    // revoked or cleaned up between the read and here, it says so, and that
    // answer wins over the one we read a moment ago.
    const touched = await clientStore.touch(token.clientId, now);
    if (touched === "revoked" || touched === "missing") return UNAUTHORIZED;

    return {
      outcome: "authenticated",
      principal: { kind: "installation", clientId: token.clientId },
    };
  } catch {
    // The error is swallowed rather than inspected: it can carry store
    // internals, and every branch here leads to the same answer anyway.
    return { outcome: "unavailable" };
  }
}
