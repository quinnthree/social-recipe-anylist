/**
 * The gate in front of every live external suite.
 *
 * `QA_LIVE_EXTERNAL=1` means **run or fail**, never "run if convenient". The
 * flag is an explicit request to exercise the real store, so silence is the
 * wrong answer to it: a suite that skips itself for want of credentials and
 * exits 0 reports a pass for work that never happened, and the M5E-B4
 * verification gates are read from exactly that exit code.
 *
 * Without the flag, the suites stay skipped and the normal run stays offline —
 * unchanged, and deliberately so. Gating on the flag as well as the credentials
 * is what keeps a developer's populated `.env` from quietly pulling the normal
 * suite onto the network.
 */

/** Either naming works: the Vercel Marketplace integration has used each. */
const URL_VARIABLES = ["KV_REST_API_URL", "UPSTASH_REDIS_REST_URL"] as const;
const TOKEN_VARIABLES = ["KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_TOKEN"] as const;

export function liveExternalRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["QA_LIVE_EXTERNAL"] === "1";
}

/**
 * The variable names a run is missing, as a human-readable list.
 *
 * Names only. A message about credentials is not a place to put one, and this
 * string is printed on a failure path where nobody is looking closely.
 */
export function missingUpstashVariables(env: NodeJS.ProcessEnv = process.env): string[] {
  const missing: string[] = [];

  if (!anyPresent(env, URL_VARIABLES)) missing.push(URL_VARIABLES.join(" or "));
  if (!anyPresent(env, TOKEN_VARIABLES)) missing.push(TOKEN_VARIABLES.join(" or "));

  return missing;
}

export function upstashConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return missingUpstashVariables(env).length === 0;
}

export class LiveExternalConfigurationError extends Error {
  constructor(missing: readonly string[]) {
    super(
      `QA_LIVE_EXTERNAL=1 requests the live external suites, but Upstash is not configured. ` +
        `Set: ${missing.join("; ")}. ` +
        `These suites verify the store that actually runs in production, so a missing ` +
        `configuration is a failed verification rather than a skipped one.`,
    );
    this.name = "LiveExternalConfigurationError";
  }
}

/**
 * Whether a live suite should run.
 *
 * Returns `false` to skip when the flag is absent, and **throws** when the flag
 * is present and the configuration is not — which fails collection of the
 * calling file and takes the exit code with it.
 */
export function requireLiveUpstash(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!liveExternalRequested(env)) return false;

  const missing = missingUpstashVariables(env);
  if (missing.length > 0) throw new LiveExternalConfigurationError(missing);

  return true;
}

/** A blank value is not a credential, and must not read as one. */
function anyPresent(env: NodeJS.ProcessEnv, names: readonly string[]): boolean {
  return names.some((name) => (env[name] ?? "").trim().length > 0);
}
