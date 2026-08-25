import { z } from "zod";

import { RecipeInputSchema } from "./recipe-input.js";

/** The only schema version this deployment speaks. */
export const SUPPORTED_SCHEMA_VERSION = 1;

export const ImportsRequestSchema = z.strictObject({
  schemaVersion: z.literal(SUPPORTED_SCHEMA_VERSION),
  url: z.string().url(),
});

/**
 * Registration carries a version and nothing else (ADR-026): no installation
 * id, no device identifier, no attestation, no client-supplied secret. Strict,
 * so a client that invents a field is told rather than silently ignored.
 */
export const RegisterRequestSchema = z.strictObject({
  schemaVersion: z.literal(SUPPORTED_SCHEMA_VERSION),
});

export const ExportRequestSchema = z.strictObject({
  schemaVersion: z.literal(SUPPORTED_SCHEMA_VERSION),
  recipe: RecipeInputSchema,
});

/**
 * Why `schemaVersion` is read before the body is parsed.
 *
 * The contract distinguishes two failures that a single strict parse would
 * collapse into one: a missing or non-integer version is `400 Invalid request
 * body`, while a well-formed but unsupported version is `400 Unsupported schema
 * version`. The second tells a future client exactly what is wrong — it spoke a
 * version we do not implement — and that is the whole reason the field exists.
 */
export type VersionCheck =
  | { ok: true }
  | { ok: false; kind: "invalid_body" | "unsupported_schema_version" };

export function checkSchemaVersion(body: unknown): VersionCheck {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, kind: "invalid_body" };
  }

  const { schemaVersion } = body as { schemaVersion?: unknown };

  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion)) {
    return { ok: false, kind: "invalid_body" };
  }

  if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return { ok: false, kind: "unsupported_schema_version" };
  }

  return { ok: true };
}

/** Control characters would corrupt a log line or a store key. */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

/**
 * `Idempotency-Key` is required on the export route and opaque to us — we never
 * parse meaning out of it, only bound its length and refuse characters that
 * would corrupt the places it gets written.
 */
export function readIdempotencyKey(header: unknown): string | null {
  const value = Array.isArray(header) ? header[0] : header;

  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_IDEMPOTENCY_KEY_LENGTH) return null;
  if (CONTROL_CHARACTERS.test(value)) return null;
  if (value.trim().length === 0) return null;

  return value;
}
