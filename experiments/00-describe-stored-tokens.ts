import { OutputGuard } from "./lib/redact.js";
import { describeError, describeTokens, guardTokens, readTokens, tokenFilePath } from "./lib/session.js";

/**
 * Prints the safe description of whatever session material is currently stored.
 * Offline: no login, no AnyList request. Useful for checking what a stored blob
 * is before deciding whether it is worth restoring.
 */
function main(): void {
  const guard = new OutputGuard();
  const tokens = readTokens();
  guardTokens(guard, tokens);

  guard.log("token file:", tokenFilePath());
  guard.log("stored session material:", describeTokens(tokens));

  // Printed so `expiresAt` above can be read as "expired" or "still live".
  guard.log("current time (unix seconds):", Math.floor(Date.now() / 1000));
}

try {
  main();
} catch (error) {
  const guard = new OutputGuard();
  console.error("failed:", describeError(guard, error));
  process.exitCode = 1;
}
