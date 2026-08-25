import { describe, expect, it } from "vitest";

import { fingerprintOf } from "../../src/http/fingerprint.js";
import { MemoryIdempotencyStore } from "../../src/idempotency/memory-store.js";
import { RETENTION_SECONDS, storeKey } from "../../src/idempotency/store.js";
import {
  retentionModeFor,
  TTL_TOLERANCE_SECONDS,
  isValidIdempotencyKey,
  KEY_MAX_LENGTH,
  mayCallCreateRecipe,
  REQUIRED_ACTION,
  REQUIRED_RESPONSE,
  runFingerprintConformance,
  runIdempotencyStoreConformance,
  type ClaimStatus,
} from "./idempotency-contract.js";

/**
 * Independent verification of the idempotency contract against the real
 * implementation.
 *
 * The conformance suite runs against `MemoryIdempotencyStore`, which the
 * production server never constructs (ADR-012) but which the contract requires
 * to model the same semantics as Redis. Running the same suite against real
 * Upstash is a LIVE EXTERNAL release-gate item — the suite takes a factory
 * precisely so that can be done without rewriting anything.
 */

const SECOND_MS = 1000;

describe("idempotency store conformance (in-process store)", () => {
  runIdempotencyStoreConformance({
    createStore: () => new MemoryIdempotencyStore(),
    completedRetentionMs: RETENTION_SECONDS.COMPLETED * SECOND_MS,
    ambiguousRetentionMs: RETENTION_SECONDS.AMBIGUOUS * SECOND_MS,
  });
});

describe("fingerprint conformance (production implementation)", () => {
  runFingerprintConformance(fingerprintOf);
});

describe("retention is state-dependent, not a flat TTL (ADR-025, QA-021)", () => {
  it("keeps an uncertain outcome far longer than a settled one", () => {
    // QA-021 RESOLVED. A flat 24-hour TTL would have let an IN_PROGRESS or
    // AMBIGUOUS record expire, read as unseen, and permit a second AnyList
    // write *solely because time passed* — unfixable, since deleteRecipe
    // cannot clean up a duplicate (ADR-021).
    expect(RETENTION_SECONDS.AMBIGUOUS).toBeGreaterThan(RETENTION_SECONDS.COMPLETED);
    expect(RETENTION_SECONDS.IN_PROGRESS).toBeGreaterThan(RETENTION_SECONDS.COMPLETED);
  });

  it("settles COMPLETED and FAILED_SAFE at the contracted 24 hours", () => {
    expect(RETENTION_SECONDS.COMPLETED).toBe(24 * 60 * 60);
    expect(RETENTION_SECONDS.FAILED_SAFE).toBe(24 * 60 * 60);
  });
});

describe("store keys never carry the client's raw key", () => {
  it("hashes the client key", () => {
    // The raw Idempotency-Key must not reach a store key, a log line, or an
    // error. A client could put anything in it.
    const key = storeKey("/api/exports/anylist", "customer-secret-key");

    expect(key).not.toContain("customer-secret-key");
    expect(key).toMatch(/^idem:v1:\/api\/exports\/anylist:[0-9a-f]{64}$/);
  });

  it("scopes the key by route, so the same client key cannot collide across routes", () => {
    expect(storeKey("/api/exports/anylist", "k")).not.toBe(storeKey("/api/imports", "k"));
  });

  it("is version-prefixed, so changing normalisation invalidates old records", () => {
    expect(storeKey("/api/exports/anylist", "k").startsWith("idem:v1:")).toBe(true);
  });
});

describe("Idempotency-Key validation", () => {
  it("requires a key: it is mandatory on POST /api/exports/anylist", () => {
    expect(isValidIdempotencyKey(undefined)).toBe(false);
  });

  it("rejects an empty key", () => {
    expect(isValidIdempotencyKey("")).toBe(false);
  });

  it("accepts a key from 1 to 128 characters", () => {
    expect(isValidIdempotencyKey("k")).toBe(true);
    expect(isValidIdempotencyKey("x".repeat(KEY_MAX_LENGTH))).toBe(true);
  });

  it("rejects a key over 128 characters", () => {
    expect(isValidIdempotencyKey("x".repeat(KEY_MAX_LENGTH + 1))).toBe(false);
  });
});

describe("the policy table", () => {
  const ALL: ClaimStatus[] = ["claimed", "conflict", "in_progress", "ambiguous", "completed"];

  it("assigns an action to every claim outcome", () => {
    for (const status of ALL) expect(REQUIRED_ACTION[status]).toBeTruthy();
  });

  it("permits an AnyList write for exactly one outcome", () => {
    // `claimed` covers a first claim and a FAILED_SAFE re-claim: both mean no
    // write has happened. Nothing else may reach createRecipe.
    const writable = ALL.filter((status) => mayCallCreateRecipe(REQUIRED_ACTION[status]));

    expect(writable).toEqual(["claimed"]);
  });

  it("never permits a write after an ambiguous outcome", () => {
    expect(mayCallCreateRecipe(REQUIRED_ACTION.ambiguous)).toBe(false);
  });

  it("never permits a write while an export is in progress", () => {
    expect(mayCallCreateRecipe(REQUIRED_ACTION.in_progress)).toBe(false);
  });

  it("replays rather than re-writes a completed request", () => {
    expect(REQUIRED_ACTION.completed).toBe("REPLAY");
    expect(mayCallCreateRecipe("REPLAY")).toBe(false);
  });

  it("pins a distinct 409 for each rejecting outcome", () => {
    expect(REQUIRED_RESPONSE.REJECT_CONFLICT).toEqual({
      status: 409,
      error: "Idempotency key conflict",
    });
    expect(REQUIRED_RESPONSE.REJECT_IN_PROGRESS).toEqual({
      status: 409,
      error: "Export already in progress",
    });
    expect(REQUIRED_RESPONSE.REJECT_AMBIGUOUS).toEqual({
      status: 409,
      error: "Export outcome unknown",
    });
  });

  it("uses three different error strings, so a client can tell them apart", () => {
    const messages = [
      REQUIRED_RESPONSE.REJECT_CONFLICT.error,
      REQUIRED_RESPONSE.REJECT_IN_PROGRESS.error,
      REQUIRED_RESPONSE.REJECT_AMBIGUOUS.error,
    ];

    expect(new Set(messages).size).toBe(3);
  });
});

describe("what idempotency does not promise", () => {
  it("cannot be exactly-once against AnyList", () => {
    // ADR-012, as a test so it cannot quietly be claimed otherwise. AnyList
    // exposes no idempotency key, so a write that landed but whose outcome we
    // never learned is undetectable by protocol. AMBIGUOUS names that hole.
    expect(mayCallCreateRecipe(REQUIRED_ACTION.ambiguous)).toBe(false);
  });

  it("cannot be cleaned up after the fact either", () => {
    // ADR-021, RESEARCH-PROVEN: deleteRecipe() reports success without
    // deleting, which is why an ambiguous outcome refuses to retry.
    expect(REQUIRED_ACTION.ambiguous).not.toBe("EXECUTE");
  });
});


/**
 * Which half of the retention boundary a target proves.
 *
 * The in-process store can step past a window and watch a record vanish; Redis
 * cannot, and asking it to was what produced the single live failure in
 * M5E-B4. The capability is explicit so the difference is visible in the suite
 * rather than absorbed by a skip.
 */
describe("retention verification is chosen by clock capability", () => {
  const readTtlSeconds = async (): Promise<number> => 86_400;

  it("verifies expiry against a logical clock by default", () => {
    expect(retentionModeFor({})).toBe("logical");
    expect(retentionModeFor({ supportsLogicalTimeTravel: true })).toBe("logical");
  });

  it("verifies the applied TTL when the clock cannot be advanced", () => {
    expect(retentionModeFor({ supportsLogicalTimeTravel: false, readTtlSeconds })).toBe("ttl");
  });

  it("refuses a target that would verify retention in neither direction", () => {
    // The gap this capability exists to prevent: without the guard, dropping
    // the reader would silently stop verifying retention at all and the run
    // would still report green.
    expect(() => retentionModeFor({ supportsLogicalTimeTravel: false })).toThrow(
      /must supply readTtlSeconds/,
    );
  });

  it("ignores a reader it does not need", () => {
    expect(retentionModeFor({ supportsLogicalTimeTravel: true, readTtlSeconds })).toBe("logical");
  });

  it("tolerates a round trip without tolerating a wrong value", () => {
    const contracted = RETENTION_SECONDS.COMPLETED;

    // Loose enough never to flake on network delay, far too tight to hide a
    // materially different retention.
    expect(TTL_TOLERANCE_SECONDS).toBeGreaterThan(0);
    expect(TTL_TOLERANCE_SECONDS).toBeLessThan(contracted / 100);
  });
});
