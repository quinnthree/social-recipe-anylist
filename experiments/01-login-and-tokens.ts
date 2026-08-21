import { AnyListClient } from "@anylist-napi/anylist-napi";

import { OutputGuard } from "./lib/redact.js";
import {
  describeError,
  describeTokens,
  guardTokens,
  loadCredentials,
  timed,
  writeTokens,
} from "./lib/session.js";

/**
 * Experiment 1 — what login() returns, what getTokens() contains, and whether a
 * second login on the same credentials produces the same session.
 *
 * Writes the captured tokens to the token file so experiment 02 can attempt a
 * restore from a genuinely separate process.
 */
async function main(): Promise<void> {
  const guard = new OutputGuard();
  const { email, password } = loadCredentials();
  guard.register(email, password);

  const first = await timed(() => AnyListClient.login(email, password));
  const client = first.result;

  guard.log("login() latency ms:", Math.round(first.ms));
  guard.log("login() returns:", {
    constructor: client.constructor.name,
    isPromise: client instanceof Promise,
    ownKeys: Object.keys(client),
    prototypeMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(client) as object)
      .filter((name) => name !== "constructor")
      .sort(),
  });

  const tokens = client.getTokens();
  guardTokens(guard, tokens);
  guard.log("getTokens() shape:", describeTokens(tokens));

  // Does reading tokens twice from one client return identical material?
  const again = client.getTokens();
  guard.log("getTokens() is stable within a client:", {
    accessTokenUnchanged: again.accessToken === tokens.accessToken,
    refreshTokenUnchanged: again.refreshToken === tokens.refreshToken,
  });

  // Does an authenticated read mutate the session in place?
  try {
    const read = await timed(() => client.getRecipes());
    const afterRead = client.getTokens();
    guardTokens(guard, afterRead);
    guard.log("after an authenticated read:", {
      latencyMs: Math.round(read.ms),
      recipeCount: read.result.length,
      accessTokenUnchanged: afterRead.accessToken === tokens.accessToken,
      refreshTokenUnchanged: afterRead.refreshToken === tokens.refreshToken,
    });
  } catch (error) {
    guard.log("authenticated read failed:", describeError(guard, error));
  }

  // A second login: same account, new process-local session or the same one?
  const second = await timed(() => AnyListClient.login(email, password));
  const secondTokens = second.result.getTokens();
  guardTokens(guard, secondTokens);
  guard.log("second login():", {
    latencyMs: Math.round(second.ms),
    isSameObject: second.result === client,
    sameUserId: secondTokens.userId === tokens.userId,
    sameAccessToken: secondTokens.accessToken === tokens.accessToken,
    sameRefreshToken: secondTokens.refreshToken === tokens.refreshToken,
  });

  // Does issuing a second session invalidate the first?
  try {
    const stillWorks = await client.getRecipes();
    guard.log("first session after a second login:", {
      stillUsable: true,
      recipeCount: stillWorks.length,
    });
  } catch (error) {
    guard.log("first session after a second login: FAILED", describeError(guard, error));
  }

  writeTokens(tokens);
  guard.log("tokens written for the cross-process experiment (file is gitignored)");
}

main().catch((error: unknown) => {
  const guard = new OutputGuard();
  console.error("experiment failed:", describeError(guard, error));
  process.exitCode = 1;
});
