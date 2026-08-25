import type { LimitDescriptor } from "../ratelimit/store.js";

/**
 * The metering policy (ADR-027).
 *
 * Values are configuration rather than constants in route logic, because they
 * will move as real usage data arrives and the code that enforces them should
 * not.
 */

const HOUR_SECONDS = 60 * 60;
const DAY_SECONDS = 24 * HOUR_SECONDS;
const MINUTE_SECONDS = 60;

export interface LimitPolicy {
  registrationPerIpHour: number;
  registrationPerIpDay: number;
  /**
   * The ceiling that does not depend on attributing a request to an address.
   *
   * Per-IP limits rest on reading a forwarded header correctly; this one does
   * not, which is why it exists. A distributed mint would have to get past it
   * whatever it does about addresses.
   */
  registrationGlobalMinute: number;
  importsPerClientDay: number;
  exportsPerClientDay: number;
}

export const DEFAULT_LIMITS: LimitPolicy = {
  registrationPerIpHour: 5,
  registrationPerIpDay: 20,
  /**
   * 20/minute.
   *
   * Chosen against what the per-IP limits already allow: 20 a minute is
   * roughly sixty times a single address's entire daily allowance, so no
   * legitimate burst — a household installing together, a demo, a launch —
   * comes near it, while a distributed attempt would need thousands of
   * addresses to sustain it and would still be capped at about 29k a day
   * rather than an open tap.
   *
   * Deliberately low for a product with no users yet. It should be raised
   * deliberately, against measured demand, rather than pre-emptively.
   */
  registrationGlobalMinute: 20,
  importsPerClientDay: 20,
  exportsPerClientDay: 40,
};

export function resolveLimits(env: NodeJS.ProcessEnv): LimitPolicy {
  return {
    registrationPerIpHour: positiveInt(
      env["REGISTRATION_LIMIT_PER_IP_HOUR"],
      DEFAULT_LIMITS.registrationPerIpHour,
    ),
    registrationPerIpDay: positiveInt(
      env["REGISTRATION_LIMIT_PER_IP_DAY"],
      DEFAULT_LIMITS.registrationPerIpDay,
    ),
    registrationGlobalMinute: positiveInt(
      env["REGISTRATION_LIMIT_GLOBAL_MINUTE"],
      DEFAULT_LIMITS.registrationGlobalMinute,
    ),
    importsPerClientDay: positiveInt(
      env["CONSUMER_IMPORT_LIMIT_PER_DAY"],
      DEFAULT_LIMITS.importsPerClientDay,
    ),
    exportsPerClientDay: positiveInt(
      env["CONSUMER_EXPORT_LIMIT_PER_DAY"],
      DEFAULT_LIMITS.exportsPerClientDay,
    ),
  };
}

/** All three registration limits, charged together or not at all. */
export function registrationLimits(policy: LimitPolicy, ip: string): LimitDescriptor[] {
  return [
    {
      scope: "register:ip:hour",
      subject: ip,
      limit: policy.registrationPerIpHour,
      windowSeconds: HOUR_SECONDS,
    },
    {
      scope: "register:ip:day",
      subject: ip,
      limit: policy.registrationPerIpDay,
      windowSeconds: DAY_SECONDS,
    },
    {
      scope: "register:global:minute",
      subject: "global",
      limit: policy.registrationGlobalMinute,
      windowSeconds: MINUTE_SECONDS,
    },
  ];
}

/** The consumer quota for a route, or `null` where the route is not metered. */
export function consumerQuota(
  policy: LimitPolicy,
  route: string,
  clientId: string,
): LimitDescriptor | null {
  if (route === "/api/imports") {
    return {
      scope: "imports:client:day",
      subject: clientId,
      limit: policy.importsPerClientDay,
      windowSeconds: DAY_SECONDS,
    };
  }

  if (route === "/api/exports/anylist") {
    return {
      scope: "exports:client:day",
      subject: clientId,
      limit: policy.exportsPerClientDay,
      windowSeconds: DAY_SECONDS,
    };
  }

  return null;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
