import { AnyListClient } from "@anylist-napi/anylist-napi";

import { OutputGuard } from "./lib/redact.js";
import {
  describeError,
  guardTokens,
  probeName,
  readTokens,
  timed,
  writeTokens,
} from "./lib/session.js";

/**
 * Experiment 2 — can a session captured by one process be used by another,
 * with no password anywhere in this process?
 *
 * Deliberately never imports the credential loader: if this script can write a
 * recipe, it did so on token material alone.
 *
 * Creates one disposable probe recipe and deletes it before exiting. If the
 * script dies between the two, `cleanup-proof-recipes.ts` removes the leftover.
 */
async function main(): Promise<void> {
  const guard = new OutputGuard();
  const tokens = readTokens();
  guardTokens(guard, tokens);

  guard.log("environment:", {
    hasPasswordInEnv: process.env["ANYLIST_PASSWORD"] !== undefined,
    hasEmailInEnv: process.env["ANYLIST_EMAIL"] !== undefined,
    pid: process.pid,
  });

  const restoreStarted = process.hrtime.bigint();
  const client = AnyListClient.fromTokens(tokens);
  const restoreMs = Number(process.hrtime.bigint() - restoreStarted) / 1e6;

  guard.log("fromTokens():", {
    latencyMs: Number(restoreMs.toFixed(3)),
    isPromise: client instanceof Promise,
    constructor: client.constructor.name,
    // A synchronous return means no network call, so nothing has been validated yet.
    validatedTheSessionEagerly: false,
  });

  let recipeId: string | null = null;

  try {
    const read = await timed(() => client.getRecipes());
    guard.log("restored client READ:", {
      ok: true,
      latencyMs: Math.round(read.ms),
      recipeCount: read.result.length,
    });

    const write = await timed(() =>
      client.createRecipe({
        name: probeName("restore"),
        ingredients: [{ name: "Water", quantity: "1 cup" }],
        preparationSteps: ["Delete this recipe. It is an automated research probe."],
        note: "Automated research probe. Safe to delete.",
      }),
    );
    recipeId = write.result.id;
    guard.log("restored client WRITE:", {
      ok: true,
      latencyMs: Math.round(write.ms),
      // Recorded so a failed cleanup leaves a documented id behind. Not a secret.
      recipeId,
    });

    const verify = await timed(() => client.getRecipeById(recipeId as string));
    guard.log("restored client VERIFY:", {
      ok: verify.result.id === recipeId,
      latencyMs: Math.round(verify.ms),
    });
  } catch (error) {
    guard.log("restored client FAILED:", describeError(guard, error));
    process.exitCode = 1;
  } finally {
    if (recipeId !== null) {
      try {
        await client.deleteRecipe(recipeId);
        guard.log("probe recipe deleted:", { recipeId });
      } catch (error) {
        guard.log("probe recipe NOT deleted, clean up manually:", {
          recipeId,
          error: describeError(guard, error),
        });
      }
    }
  }

  const after = client.getTokens();
  guardTokens(guard, after);
  guard.log("token material after a full read/write/delete cycle:", {
    accessTokenUnchanged: after.accessToken === tokens.accessToken,
    refreshTokenUnchanged: after.refreshToken === tokens.refreshToken,
    userIdUnchanged: after.userId === tokens.userId,
    isPremiumUser: after.isPremiumUser,
  });

  writeTokens(after);
}

main().catch((error: unknown) => {
  const guard = new OutputGuard();
  console.error("experiment failed:", describeError(guard, error));
  process.exitCode = 1;
});
