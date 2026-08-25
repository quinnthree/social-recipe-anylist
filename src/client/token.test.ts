import { describe, expect, it } from "vitest";

import {
  buildToken,
  CLIENT_ID_BYTES,
  hashSecret,
  isClientId,
  isSecretHash,
  mintClientId,
  mintCredential,
  mintSecret,
  parseToken,
  SECRET_BYTES,
  TOKEN_LENGTH,
  TOKEN_PREFIX,
  verifySecret,
} from "./token.js";

const decoded = (value: string): Buffer => Buffer.from(value, "base64url");

describe("minting", () => {
  it("mints a clientId of the contracted entropy", () => {
    expect(decoded(mintClientId())).toHaveLength(CLIENT_ID_BYTES);
  });

  it("mints a 256-bit secret", () => {
    expect(decoded(mintSecret())).toHaveLength(SECRET_BYTES);
  });

  it("never repeats", () => {
    const ids = new Set(Array.from({ length: 200 }, mintClientId));
    const secrets = new Set(Array.from({ length: 200 }, mintSecret));

    expect(ids.size).toBe(200);
    expect(secrets.size).toBe(200);
  });

  it("builds a token of exactly the documented shape", () => {
    const { token, clientId } = mintCredential();

    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(token).toHaveLength(TOKEN_LENGTH);
    expect(token.slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + clientId.length)).toBe(clientId);
  });

  it("returns a digest to store and never the raw secret", () => {
    const credential = mintCredential();

    expect(Object.keys(credential).sort()).toEqual(["clientId", "secretHash", "token"]);
    expect(isSecretHash(credential.secretHash)).toBe(true);

    // The digest must not be derivable from the object by inspection: it is a
    // hash of the secret, and the secret only exists inside the token.
    const parsed = parseToken(credential.token);
    expect(hashSecret(parsed!.secret)).toBe(credential.secretHash);
    expect(credential.secretHash).not.toContain(parsed!.secret);
  });
});

describe("parsing", () => {
  it("round-trips a minted token", () => {
    const clientId = mintClientId();
    const secret = mintSecret();

    expect(parseToken(buildToken(clientId, secret))).toEqual({ clientId, secret });
  });

  /**
   * The separator is a member of the base64url alphabet, so roughly a third of
   * minted tokens contain one inside a component. Splitting on `_` would reject
   * them; parsing is positional for exactly this reason.
   */
  it("accepts components that contain the separator", () => {
    const clientId = Buffer.alloc(CLIENT_ID_BYTES, 0xff).toString("base64url");
    const secret = Buffer.alloc(SECRET_BYTES, 0xff).toString("base64url");

    expect(clientId).toContain("_");
    expect(secret).toContain("_");
    expect(parseToken(buildToken(clientId, secret))).toEqual({ clientId, secret });
  });

  it("round-trips every minted token, whatever bytes it drew", () => {
    for (let i = 0; i < 500; i += 1) {
      const { token, clientId } = mintCredential();
      expect(parseToken(token)?.clientId).toBe(clientId);
    }
  });

  const valid = buildToken(mintClientId(), mintSecret());

  it.each([
    ["a non-string", 42],
    ["undefined", undefined],
    ["an empty string", ""],
    ["the prefix alone", TOKEN_PREFIX],
    ["a wrong version prefix", `sr2_${valid.slice(TOKEN_PREFIX.length)}`],
    ["no prefix", valid.slice(TOKEN_PREFIX.length)],
    ["a truncated token", valid.slice(0, valid.length - 1)],
    ["an over-long token", `${valid}A`],
    ["a missing secret", `${TOKEN_PREFIX}${mintClientId()}_`],
    ["a missing clientId", `${TOKEN_PREFIX}_${mintSecret()}`],
    ["a leading space", ` ${valid}`],
    ["a trailing newline", `${valid}\n`],
    ["an inner space", `${valid.slice(0, 30)} ${valid.slice(31)}`],
    ["a non-base64url character", `${valid.slice(0, 30)}+${valid.slice(31)}`],
    ["standard base64 padding", `${valid.slice(0, 30)}=${valid.slice(31)}`],
  ])("rejects %s", (_label, token) => {
    expect(parseToken(token)).toBeNull();
  });

  it("rejects components of the wrong decoded length", () => {
    const shortId = Buffer.alloc(CLIENT_ID_BYTES - 1).toString("base64url");
    const longSecret = Buffer.alloc(SECRET_BYTES + 1).toString("base64url");

    expect(parseToken(buildToken(shortId, mintSecret()))).toBeNull();
    expect(parseToken(buildToken(mintClientId(), longSecret))).toBeNull();
  });

  it("rejects a non-canonical encoding of the right length", () => {
    // 22 base64url characters carry 132 bits, but a clientId is 128. A value
    // whose trailing bits are non-zero decodes to 16 bytes and re-encodes to
    // something else — accepting it would mean two spellings of one id.
    const canonical = mintClientId();
    const tampered = `${canonical.slice(0, 21)}B`;

    if (tampered !== canonical && decoded(tampered).toString("base64url") !== tampered) {
      expect(parseToken(buildToken(tampered, mintSecret()))).toBeNull();
    }

    // Constructed directly so the assertion does not depend on random bytes.
    const nonCanonical = "AAAAAAAAAAAAAAAAAAAAAB";
    expect(decoded(nonCanonical)).toHaveLength(CLIENT_ID_BYTES);
    expect(decoded(nonCanonical).toString("base64url")).not.toBe(nonCanonical);
    expect(parseToken(buildToken(nonCanonical, mintSecret()))).toBeNull();
  });

  it("recognises a clientId on its own, for store lookups", () => {
    expect(isClientId(mintClientId())).toBe(true);
    expect(isClientId(mintSecret())).toBe(false);
    expect(isClientId("")).toBe(false);
    expect(isClientId(" ".repeat(22))).toBe(false);
    expect(isClientId(undefined)).toBe(false);
  });
});

describe("hashing and verification", () => {
  it("is deterministic", () => {
    const secret = mintSecret();

    expect(hashSecret(secret)).toBe(hashSecret(secret));
    expect(isSecretHash(hashSecret(secret))).toBe(true);
  });

  it("separates different secrets", () => {
    expect(hashSecret(mintSecret())).not.toBe(hashSecret(mintSecret()));
  });

  it("never returns the secret as its stored representation", () => {
    const secret = mintSecret();
    const digest = hashSecret(secret);

    expect(digest).not.toContain(secret);
    expect(digest).not.toBe(secret);
    expect(digest).toHaveLength(64);
  });

  it("accepts the correct secret", () => {
    const secret = mintSecret();

    expect(verifySecret(secret, hashSecret(secret))).toBe(true);
  });

  it("rejects a wrong secret", () => {
    expect(verifySecret(mintSecret(), hashSecret(mintSecret()))).toBe(false);
  });

  it("rejects a stored digest of the wrong length without throwing", () => {
    // timingSafeEqual throws on a length mismatch; hashing both sides again
    // means the comparison never sees one, so a corrupted record fails as a
    // mismatch rather than as an exception on the authentication path.
    const secret = mintSecret();

    expect(() => verifySecret(secret, "")).not.toThrow();
    expect(verifySecret(secret, "")).toBe(false);
    expect(verifySecret(secret, "a".repeat(500))).toBe(false);
    expect(verifySecret(secret, hashSecret(secret).slice(0, 63))).toBe(false);
  });

  it("recognises a well-formed digest", () => {
    expect(isSecretHash(hashSecret("x"))).toBe(true);
    expect(isSecretHash(hashSecret("x").toUpperCase())).toBe(false);
    expect(isSecretHash("zz".repeat(32))).toBe(false);
    expect(isSecretHash(undefined)).toBe(false);
  });
});
