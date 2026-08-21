import { readFileSync, writeFileSync } from "node:fs";

import { config } from "dotenv";

import { OutputGuard, describeSecret, summariseJwtClaims } from "./redact.js";

/**
 * Shared plumbing for the live AnyList session experiments.
 *
 * Credentials come from a .env file and are never written anywhere by these
 * scripts. Captured session material goes to a token file that defaults to a
 * path already covered by .gitignore, and is described through `redact.ts`
 * rather than printed.
 */

export interface SavedTokensShape {
  userId: string;
  accessToken: string;
  refreshToken: string;
  isPremiumUser: boolean;
}

export interface Credentials {
  email: string;
  password: string;
}

/**
 * `ANYLIST_ENV_FILE` lets a run point at a .env held in another checkout, which
 * is how these experiments avoid a second copy of live credentials on disk.
 */
export function loadCredentials(): Credentials {
  config({ path: process.env["ANYLIST_ENV_FILE"] ?? ".env", quiet: true });

  const email = process.env["ANYLIST_EMAIL"]?.trim();
  const password = process.env["ANYLIST_PASSWORD"];

  if (!email || !password) {
    throw new Error(
      "Missing ANYLIST_EMAIL / ANYLIST_PASSWORD. Set ANYLIST_ENV_FILE to a .env that has them.",
    );
  }

  return { email, password };
}

export function tokenFilePath(): string {
  return process.env["ANYLIST_TOKEN_FILE"] ?? ".anylist_credentials";
}

/** Persisted only so a *separate process* can attempt restoration. Never committed. */
export function writeTokens(tokens: SavedTokensShape): void {
  writeFileSync(tokenFilePath(), JSON.stringify(tokens), { encoding: "utf8", mode: 0o600 });
}

export function readTokens(): SavedTokensShape {
  return JSON.parse(readFileSync(tokenFilePath(), "utf8")) as SavedTokensShape;
}

/** Registers every secret in a token set with the guard before anything is printed. */
export function guardTokens(guard: OutputGuard, tokens: SavedTokensShape): void {
  guard.register(tokens.accessToken, tokens.refreshToken, tokens.userId);
}

export function describeTokens(tokens: SavedTokensShape): Record<string, unknown> {
  return {
    keys: Object.keys(tokens).sort(),
    userId: describeSecret(tokens.userId),
    accessToken: {
      ...describeSecret(tokens.accessToken),
      jwt: summariseJwtClaims(tokens.accessToken),
    },
    refreshToken: {
      ...describeSecret(tokens.refreshToken),
      jwt: summariseJwtClaims(tokens.refreshToken),
    },
    isPremiumUser: tokens.isPremiumUser,
    isPremiumUserType: typeof tokens.isPremiumUser,
  };
}

/**
 * Every failure path in these experiments funnels through here. The message is
 * reported so we can document what expiry and revocation actually look like,
 * but it is scrubbed first — provider errors in this library can carry a
 * response body.
 */
export function describeError(guard: OutputGuard, error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { nonError: guard.scrub(String(error)) };

  return {
    name: error.name,
    message: guard.scrub(error.message),
    code: guard.scrub(String((error as { code?: unknown }).code ?? "")),
  };
}

export async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const started = process.hrtime.bigint();
  const result = await fn();
  return { result, ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

/** A name no real recipe would collide with, so cleanup can find its own leftovers. */
export const PROBE_PREFIX = "ZZ-AUTH-RESEARCH-PROBE";

export function probeName(label: string): string {
  return `${PROBE_PREFIX} ${label} ${new Date().toISOString()}`;
}
