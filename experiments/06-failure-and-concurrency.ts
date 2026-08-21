import { AnyListClient } from "@anylist-napi/anylist-napi";

import { OutputGuard } from "./lib/redact.js";
import { describeError, guardTokens, loadCredentials, readTokens, timed } from "./lib/session.js";

/**
 * Experiment 6 — two questions that decide how a stateless deployment behaves.
 *
 * 1. What does a wrong password look like, and does anything escape our
 *    redaction on the way out? The native library prints to stderr itself, so
 *    this is checked by observation, not by reading our own code.
 * 2. Can several clients restored from the *same* stored token material run
 *    concurrently? On Vercel each invocation is its own process holding its own
 *    copy of the same blob, which is exactly this shape.
 *
 * Read-only. Creates nothing.
 */

const CONCURRENCY = 4;

async function loginFailureSurface(guard: OutputGuard): Promise<void> {
  const { email } = loadCredentials();
  guard.register(email);

  const wrongPassword = `definitely-not-the-password-${Date.now()}`;
  guard.register(wrongPassword);

  try {
    await AnyListClient.login(email, wrongPassword);
    guard.log("wrong password: login SUCCEEDED, which should not happen");
  } catch (error) {
    guard.log("wrong password:", describeError(guard, error));
  }
}

async function concurrentRestoredSessions(guard: OutputGuard): Promise<void> {
  const tokens = readTokens();
  guardTokens(guard, tokens);

  const run = await timed(() =>
    Promise.all(
      Array.from({ length: CONCURRENCY }, async (_unused, index) => {
        // Each iteration restores its own client from the same stored blob,
        // mirroring N stateless invocations reading one secret.
        const client = AnyListClient.fromTokens(tokens);

        try {
          const recipes = await client.getRecipes();
          const after = client.getTokens();
          return {
            index,
            ok: true,
            recipeCount: recipes.length,
            accessTokenUnchanged: after.accessToken === tokens.accessToken,
          };
        } catch (error) {
          return { index, ok: false, error: describeError(guard, error) };
        }
      }),
    ),
  );

  guard.log(`${CONCURRENCY} concurrent restored sessions:`, {
    totalMs: Math.round(run.ms),
    results: run.result,
  });
}

async function main(): Promise<void> {
  const guard = new OutputGuard();

  await loginFailureSurface(guard);
  await concurrentRestoredSessions(guard);
}

main().catch((error: unknown) => {
  const guard = new OutputGuard();
  console.error("experiment failed:", describeError(guard, error));
  process.exitCode = 1;
});
