/**
 * Categorises what the isolated AnyList child wrote to its stderr (ADR-023).
 *
 * This exists so a security regression is *observable* — if the containment
 * boundary were ever removed, the counts would show material arriving where it
 * previously did not. It reports categories and totals and nothing else: it
 * never returns, stores, or reproduces the matched text, because a reporting
 * path that echoed its findings would be the leak it exists to measure.
 */

export interface StderrReport {
  /** Bytes retained for scanning, which may be less than the child emitted. */
  bytes: number;
  setCookie: number;
  jwtLike: number;
  authorizationHeader: number;
  cookieHeader: number;
  bearerToken: number;
  /** True when any category above is non-zero. */
  prohibited: boolean;
  /** True when the child exceeded the retention ceiling. */
  truncated: boolean;
}

const PATTERNS: ReadonlyArray<readonly [keyof StderrReport, RegExp]> = [
  ["setCookie", /set-cookie/gi],
  // Three base64url segments of JWT size. Ordinary base64-ish noise does not match.
  ["jwtLike", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ["authorizationHeader", /"?authorization"?\s*:/gi],
  ["cookieHeader", /(^|[^-])\bcookie"?\s*:/gi],
  ["bearerToken", /bearer\s+[A-Za-z0-9._-]{16,}/gi],
];

export function scanStderr(text: string, truncated = false): StderrReport {
  const report: StderrReport = {
    bytes: Buffer.byteLength(text, "utf8"),
    setCookie: 0,
    jwtLike: 0,
    authorizationHeader: 0,
    cookieHeader: 0,
    bearerToken: 0,
    prohibited: false,
    truncated,
  };

  for (const [key, pattern] of PATTERNS) {
    (report[key] as number) = text.match(pattern)?.length ?? 0;
  }

  report.prohibited =
    report.setCookie +
      report.jwtLike +
      report.authorizationHeader +
      report.cookieHeader +
      report.bearerToken >
    0;

  return report;
}

/** An empty report, for paths where no child was ever started. */
export function emptyStderrReport(): StderrReport {
  return scanStderr("");
}
