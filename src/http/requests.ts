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

const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

/**
 * The canonical UUID text form, `8-4-4-4-12` hex, case-insensitive.
 *
 * Version and variant bits are deliberately **not** pinned. The purpose is
 * shape and entropy, not provenance: a client emitting UUIDv7 keys is as
 * collision-free as one emitting v4, and rejecting it would buy nothing. The
 * native client already sends `UUID().uuidString`, so this promotes an existing
 * convention into a contract rather than asking anyone to change.
 *
 * **This is not an authorization boundary.** It makes an accidental collision
 * between two installations choosing the same key negligibly unlikely; it says
 * nothing about who is entitled to a key. A client that repeats one fixed UUID
 * for different recipes still gets `409 Idempotency key conflict`, which is the
 * safe answer, so no degenerate value — the nil UUID included — is special-cased
 * here.
 */
const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * `Idempotency-Key` is required on the export route and stays opaque to us — we
 * validate its shape and never parse meaning out of it.
 *
 * **An accepted value is returned exactly as supplied.** It is not trimmed,
 * case-folded, parsed, or re-serialised, and it must never become any of those:
 * `storeKey` hashes these bytes, every existing `idem:v1` record was written
 * from the bytes a client actually sent, and a record keyed on a normalised
 * variant would be invisible to the retry that created it — permitting a second
 * AnyList write that ADR-021 says cannot be undone. Validation may reject a
 * value; it may not transform one.
 *
 * The length bound is kept even though the shape already implies 36 characters,
 * so the cheapest check still runs first on a hostile input.
 */
export function readIdempotencyKey(header: unknown): string | null {
  const value = Array.isArray(header) ? header[0] : header;

  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_IDEMPOTENCY_KEY_LENGTH) return null;
  if (!UUID_SHAPE.test(value)) return null;

  return value;
}
