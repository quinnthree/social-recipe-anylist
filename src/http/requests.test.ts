import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { storeKey } from "../idempotency/store.js";
import { readIdempotencyKey } from "./requests.js";

/**
 * `Idempotency-Key` validation (M6C-1).
 *
 * Two properties, and the second matters more than the first: the value must be
 * UUID-shaped, and an accepted value must come back **byte-identical**.
 * `storeKey` hashes exactly these bytes, and every existing `idem:v1` record was
 * written from the bytes a client sent — so a validator that normalised on the
 * way through would make an existing record invisible to the retry that created
 * it, and permit a second AnyList write that ADR-021 says cannot be undone.
 */

const UUID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

describe("accepted values", () => {
  it.each([
    ["lowercase", UUID],
    ["uppercase", UUID.toUpperCase()],
    ["mixed case", "7C9e6679-7425-40DE-944b-E07fc1f90AE7"],
    ["the nil UUID", "00000000-0000-0000-0000-000000000000"],
    ["a non-v4 version nibble", "7c9e6679-7425-10de-144b-e07fc1f90ae7"],
  ])("accepts %s", (_label, value) => {
    expect(readIdempotencyKey(value)).toBe(value);
  });

  it("returns the exact string it was given", () => {
    const mixed = "7C9e6679-7425-40DE-944b-E07fc1f90AE7";

    // Not trimmed, not case-folded, not re-serialised.
    expect(readIdempotencyKey(mixed)).toBe(mixed);
  });

  it("hashes the supplied bytes, so case is not collapsed", () => {
    const lower = UUID;
    const upper = UUID.toUpperCase();

    // Two spellings of the same UUID are two different keys. That is the
    // correct behaviour for a byte-preserving validator: the alternative —
    // canonicalising — would change what existing records hash to.
    expect(storeKey("exports-anylist", lower)).not.toBe(storeKey("exports-anylist", upper));
    expect(storeKey("exports-anylist", lower)).toBe(
      `idem:v1:exports-anylist:${createHash("sha256").update(lower).digest("hex")}`,
    );
  });

  it("takes the first value when the header repeats", () => {
    expect(readIdempotencyKey([UUID, "ignored"])).toBe(UUID);
  });
});

describe("rejected values", () => {
  it.each([
    ["an opaque string", "client-key-1"],
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["a UUID with leading whitespace", ` ${UUID}`],
    ["a UUID with trailing whitespace", `${UUID} `],
    ["a UUID with an embedded newline", `${UUID}\n`],
    ["a UUID without separators", UUID.replace(/-/g, "")],
    ["a UUID with a non-hex character", `g${UUID.slice(1)}`],
    ["a group of the wrong length", "7c9e667-97425-40de-944b-e07fc1f90ae7"],
    ["trailing content", `${UUID}x`],
    ["braced form", `{${UUID}}`],
    ["urn form", `urn:uuid:${UUID}`],
    ["129 characters", "x".repeat(129)],
  ])("rejects %s", (_label, value) => {
    expect(readIdempotencyKey(value)).toBeNull();
  });

  it.each([
    ["undefined", undefined],
    ["a number", 7],
    ["an object", { key: UUID }],
    ["an empty array", []],
  ])("rejects %s", (_label, value) => {
    expect(readIdempotencyKey(value)).toBeNull();
  });
});
