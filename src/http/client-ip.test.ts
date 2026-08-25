import { describe, expect, it } from "vitest";

import { resolveClientIp, resolveIpStrategy } from "./client-ip.js";

const SOCKET = "10.0.0.1";
const REAL = "203.0.113.9";
const SPOOF = "9.9.9.9";

function resolve(
  headers: Record<string, string | string[] | undefined>,
  strategy: "forwarded" | "socket" = "forwarded",
  socketAddress: string | undefined = SOCKET,
): string | null {
  return resolveClientIp({ headers, socketAddress }, strategy);
}

describe("strategy selection", () => {
  it("uses forwarded headers on the platform and the socket elsewhere", () => {
    expect(resolveIpStrategy({ VERCEL: "1" })).toBe("forwarded");
    expect(resolveIpStrategy({})).toBe("socket");
  });

  it("can be overridden explicitly", () => {
    expect(resolveIpStrategy({ VERCEL: "1", CLIENT_IP_STRATEGY: "socket" })).toBe("socket");
    expect(resolveIpStrategy({ CLIENT_IP_STRATEGY: "forwarded" })).toBe("forwarded");
    expect(resolveIpStrategy({ CLIENT_IP_STRATEGY: "nonsense" })).toBe("socket");
  });
});

describe("choosing a bucket", () => {
  it("ignores forwarded headers entirely under the socket strategy", () => {
    expect(resolve({ "x-forwarded-for": SPOOF }, "socket")).toBe(SOCKET);
  });

  it("prefers the platform's own header", () => {
    expect(
      resolve({ "x-vercel-forwarded-for": REAL, "x-forwarded-for": SPOOF }),
    ).toBe(REAL);
  });

  it("falls back to the socket when no forwarded header is present", () => {
    expect(resolve({})).toBe(SOCKET);
  });

  it("reports nothing rather than guessing when there is no address at all", () => {
    // Called directly: passing `undefined` to the helper would hit its default.
    expect(resolveClientIp({ headers: {}, socketAddress: undefined }, "forwarded")).toBeNull();
  });

  it("falls through to the socket when a forwarded header is unusable", () => {
    // Never an exemption: an unreadable address shares the proxy's bucket and
    // is limited alongside its neighbours.
    expect(resolve({ "x-forwarded-for": "  " })).toBe(SOCKET);
    expect(resolve({ "x-forwarded-for": [] })).toBe(SOCKET);
  });

  it("treats an IPv4-mapped address as the same caller", () => {
    // Otherwise switching representation would double a caller's allowance.
    expect(resolve({ "x-forwarded-for": `::ffff:${REAL}` })).toBe(REAL);
  });
});

/**
 * The property the whole per-IP limit rests on: a caller must not be able to
 * choose which bucket they are counted in.
 */
describe("a caller cannot choose their own bucket", () => {
  it("takes the rightmost entry, which is the one the proxy wrote", () => {
    // A platform that appends leaves the attacker's value to the left.
    expect(resolve({ "x-forwarded-for": `${SPOOF}, ${REAL}` })).toBe(REAL);
  });

  it("is unaffected by however many entries the caller invents", () => {
    const invented = Array.from({ length: 50 }, (_, index) => `9.9.9.${index}`).join(", ");

    expect(resolve({ "x-forwarded-for": `${invented}, ${REAL}` })).toBe(REAL);
  });

  it("takes the last value when the header is duplicated", () => {
    // Node preserves order, so the last occurrence was written closest to us.
    expect(resolve({ "x-forwarded-for": [SPOOF, REAL] })).toBe(REAL);
  });

  it("still lands on the real address when the platform replaces the header", () => {
    expect(resolve({ "x-forwarded-for": REAL })).toBe(REAL);
  });

  it("would be spoofable only by a proxy that forwards the caller's header untouched", () => {
    // Recorded rather than asserted away: no header-based rule survives this,
    // and neither does the socket address behind a proxy. This is the exact
    // assumption M5E-B4 has to confirm against the deployed platform, and the
    // global registration ceiling exists because it does not depend on it.
    expect(resolve({ "x-forwarded-for": SPOOF })).toBe(SPOOF);
  });

  it("cannot be bypassed by sending the platform header itself, if the platform strips it", () => {
    // If the platform does not strip it, this value is trusted — which is why
    // the platform header must be verified to be unforgeable in B4.
    expect(resolve({ "x-vercel-forwarded-for": SPOOF })).toBe(SPOOF);
  });
});
