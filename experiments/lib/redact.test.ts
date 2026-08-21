import { describe, expect, it } from "vitest";

import { OutputGuard, describeSecret, fingerprint, summariseJwtClaims } from "./redact.js";

/**
 * These tests exist because the redaction helper is the only thing standing
 * between live session material and an experiment transcript. They are offline
 * and use synthetic values only.
 */

const FAKE_TOKEN = "aaaabbbbccccddddeeeeffff00001111";

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.c2lnbmF0dXJl`;
}

describe("fingerprint", () => {
  it("is stable for the same input", () => {
    expect(fingerprint(FAKE_TOKEN)).toBe(fingerprint(FAKE_TOKEN));
  });

  it("differs for different inputs", () => {
    expect(fingerprint(FAKE_TOKEN)).not.toBe(fingerprint(`${FAKE_TOKEN}x`));
  });

  it("reveals no part of the input", () => {
    expect(FAKE_TOKEN).not.toContain(fingerprint(FAKE_TOKEN));
    expect(fingerprint(FAKE_TOKEN)).toHaveLength(12);
  });
});

describe("describeSecret", () => {
  it("summarises shape without echoing content", () => {
    const shape = describeSecret("Abc-123_x.y");

    expect(shape.length).toBe(11);
    expect(shape.charset).toBe("lower+upper+digit+dash+underscore+dot");
    expect(shape.segments).toBe(2);
    expect(JSON.stringify(shape)).not.toContain("Abc");
  });
});

describe("summariseJwtClaims", () => {
  it("reports a non-JWT as such", () => {
    expect(summariseJwtClaims(FAKE_TOKEN).isJwt).toBe(false);
  });

  it("extracts time claims and derives the lifetime", () => {
    const summary = summariseJwtClaims(fakeJwt({ iat: 1000, exp: 4600, sub: "secret-user-id" }));

    expect(summary.isJwt).toBe(true);
    expect(summary.issuedAt).toBe(1000);
    expect(summary.expiresAt).toBe(4600);
    expect(summary.lifetimeSeconds).toBe(3600);
  });

  it("names identity claims but never values them", () => {
    const summary = summariseJwtClaims(fakeJwt({ sub: "secret-user-id", email: "a@b.test" }));

    expect(summary.payloadKeys).toEqual(["email", "sub"]);
    expect(JSON.stringify(summary)).not.toContain("secret-user-id");
    expect(JSON.stringify(summary)).not.toContain("a@b.test");
  });
});

describe("OutputGuard", () => {
  it("masks a registered secret anywhere in the text", () => {
    const guard = new OutputGuard();
    guard.register(FAKE_TOKEN);

    const scrubbed = guard.scrub(`before ${FAKE_TOKEN} after`);

    expect(scrubbed).not.toContain(FAKE_TOKEN);
    expect(scrubbed).toContain(`[redacted:${fingerprint(FAKE_TOKEN)}]`);
  });

  it("masks the longest secret first so nested secrets do not leak a prefix", () => {
    const guard = new OutputGuard();
    const outer = `${FAKE_TOKEN}-tail`;
    guard.register(FAKE_TOKEN, outer);

    expect(guard.scrub(outer)).toBe(`[redacted:${fingerprint(outer)}]`);
  });

  it("ignores values too short to be credentials", () => {
    const guard = new OutputGuard();
    guard.register("abc");

    expect(guard.scrub("abc")).toBe("abc");
  });
});
