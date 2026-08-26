import { describe, expect, it } from "vitest";

import { emptyStderrReport, scanStderr } from "./stderr-scan.js";

/**
 * The scanner exists to make a containment regression visible (ADR-023). It must
 * therefore be able to recognise the material — and must never reproduce it,
 * because a reporting path that echoed its findings would be the leak it is
 * there to measure.
 */

const PLANTED =
  'Headers: {"set-cookie": "PLANTED_SESSION=planted-cookie-value; Path=/", ' +
  '"authorization": "Bearer planted-bearer-token-value-long-enough", ' +
  '"cookie": "PLANTED=planted-cookie-value"}\n' +
  "Body: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwbGFudGVkIn0.cGxhbnRlZC1zaWduYXR1cmU\n";

describe("scanStderr", () => {
  it("recognises every category the native leak carries", () => {
    const report = scanStderr(PLANTED);

    expect(report.setCookie).toBeGreaterThan(0);
    expect(report.jwtLike).toBeGreaterThan(0);
    expect(report.authorizationHeader).toBeGreaterThan(0);
    expect(report.cookieHeader).toBeGreaterThan(0);
    expect(report.bearerToken).toBeGreaterThan(0);
    expect(report.prohibited).toBe(true);
  });

  it("reproduces none of the material it found", () => {
    const serialised = JSON.stringify(scanStderr(PLANTED));

    for (const marker of [
      "planted-cookie-value",
      "planted-bearer-token-value",
      "PLANTED_SESSION",
      "cGxhbnRlZC1zaWduYXR1cmU",
      "eyJhbGciOiJIUzI1NiJ9",
    ]) {
      expect(serialised).not.toContain(marker);
    }
  });

  it("reports ordinary output as clean", () => {
    expect(scanStderr("recipe exported: 3 ingredients").prohibited).toBe(false);
  });

  it("does not mistake ordinary base64-ish noise for a token", () => {
    expect(scanStderr("id=eyJa.b.c value=abcdef123456").jwtLike).toBe(0);
  });

  it("carries the truncation flag through", () => {
    expect(scanStderr("anything", true).truncated).toBe(true);
    expect(scanStderr("anything").truncated).toBe(false);
  });

  it("has an empty report for paths where no child ever started", () => {
    const empty = emptyStderrReport();

    expect(empty.bytes).toBe(0);
    expect(empty.prohibited).toBe(false);
  });
});
