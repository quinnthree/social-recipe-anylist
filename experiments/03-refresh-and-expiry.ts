import { AnyListClient } from "@anylist-napi/anylist-napi";

import { OutputGuard, fingerprint } from "./lib/redact.js";
import {
  type SavedTokensShape,
  describeError,
  guardTokens,
  readTokens,
  timed,
  writeTokens,
} from "./lib/session.js";

/**
 * Experiment 3 — refresh behaviour, token rotation, and what an unusable
 * session actually looks like.
 *
 * The access token is a one-hour JWT, so waiting for a natural expiry is not
 * practical inside a research session. Instead we invalidate the signature,
 * which produces the same 401 the server returns on expiry and drives the
 * library down its real auto-refresh path.
 *
 * The questions that decide the deployment architecture:
 *   1. Does a 401 transparently recover?
 *   2. Does refreshing rotate the refresh token?
 *   3. If it rotates, does the *previous* refresh token still work?
 *   4. What error surfaces when nothing can be recovered?
 *
 * Question 3 is the one that decides whether stored session material can be
 * shared by concurrent stateless invocations.
 */

/** Same JWT, wrong signature — the server's 401 path without waiting an hour. */
function withBrokenSignature(token: string): string {
  const parts = token.split(".");
  const signature = parts[2] ?? "";
  const flipped = signature.startsWith("A") ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;
  return [parts[0], parts[1], flipped].join(".");
}

async function probeRead(
  guard: OutputGuard,
  label: string,
  tokens: SavedTokensShape,
): Promise<{ client: AnyListClient; ok: boolean }> {
  const client = AnyListClient.fromTokens(tokens);

  try {
    const read = await timed(() => client.getRecipes());
    guard.log(`${label}: SUCCEEDED`, {
      latencyMs: Math.round(read.ms),
      recipeCount: read.result.length,
    });
    return { client, ok: true };
  } catch (error) {
    guard.log(`${label}: FAILED`, describeError(guard, error));
    return { client, ok: false };
  }
}

async function main(): Promise<void> {
  const guard = new OutputGuard();
  const original = readTokens();
  guardTokens(guard, original);

  guard.log("baseline fingerprints:", {
    accessToken: fingerprint(original.accessToken),
    refreshToken: fingerprint(original.refreshToken),
  });

  // 1 + 2. A dead access token with a live refresh token.
  const broken: SavedTokensShape = {
    ...original,
    accessToken: withBrokenSignature(original.accessToken),
  };
  guard.register(broken.accessToken);

  const first = await probeRead(guard, "dead access token, live refresh token", broken);
  const afterRefresh = first.client.getTokens();
  guardTokens(guard, afterRefresh);

  guard.log("token material after the 401:", {
    accessTokenChanged: afterRefresh.accessToken !== broken.accessToken,
    accessTokenIsTheOriginal: afterRefresh.accessToken === original.accessToken,
    refreshTokenChanged: afterRefresh.refreshToken !== original.refreshToken,
    newAccessTokenFingerprint: fingerprint(afterRefresh.accessToken),
    newRefreshTokenFingerprint: fingerprint(afterRefresh.refreshToken),
  });

  // 3. Reuse of the pre-refresh refresh token. If this fails, stored session
  //    material cannot be shared by concurrent workers without coordination.
  if (afterRefresh.refreshToken !== original.refreshToken) {
    const replay: SavedTokensShape = {
      ...original,
      accessToken: withBrokenSignature(original.accessToken),
    };
    guard.register(replay.accessToken);
    await probeRead(guard, "REPLAY of the superseded refresh token", replay);
  } else {
    guard.log("refresh token did not rotate; replay question does not arise");
  }

  // 4. Nothing recoverable: both credentials invalid.
  const dead: SavedTokensShape = {
    ...original,
    accessToken: withBrokenSignature(original.accessToken),
    refreshToken: withBrokenSignature(original.refreshToken),
  };
  guard.register(dead.accessToken, dead.refreshToken);
  await probeRead(guard, "dead access token and dead refresh token", dead);

  // 5. Structurally invalid material, as a disconnected device would hold.
  await probeRead(guard, "structurally invalid tokens", {
    ...original,
    accessToken: "not-a-token",
    refreshToken: "not-a-token",
  });

  if (first.ok) writeTokens(afterRefresh);
  guard.log("token file updated with the freshest working material:", { rewritten: first.ok });
}

main().catch((error: unknown) => {
  const guard = new OutputGuard();
  console.error("experiment failed:", describeError(guard, error));
  process.exitCode = 1;
});
