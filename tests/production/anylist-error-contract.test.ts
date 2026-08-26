import { describe, expect, it } from "vitest";

import { fixture } from "../../fixtures/corpus.js";
import { requireRecipe } from "../../fixtures/types.js";
import { AnyListRecipeSaver } from "../../src/anylist/client.js";
import { AnyListError } from "../../src/anylist/types.js";
import { fakeChildRunner } from "../../src/test-support/anylist-child-double.js";
import {
  ANYLIST_ERROR_CODES,
  CODE_TO_STATE,
  OUTCOME_TO_CLAIM_STATUS,
  SCENARIO_TO_CODE,
  type AnyListErrorCode,
} from "./anylist-error-contract.js";
import { mayCallCreateRecipe, REQUIRED_ACTION } from "./idempotency-contract.js";

/**
 * The approved AnyList error classification (ADR-020), and a tripwire proving
 * it is not implemented yet.
 *
 * The mapping table is assertable today because it is a contract, not code. The
 * scenario→code specs are skipped until `AnyListError` gains its `code`.
 */

const recipe = requireRecipe(fixture("tiktok-cottage-cheese-brownies"));

interface FakeOptions {
  loginError?: unknown;
  createError?: unknown;
  verifyError?: unknown;
  verifyResult?: { id: string } | null;
}

function saverFor(options: FakeOptions): AnyListRecipeSaver {
  // The adapter's seam is the child runner now (ADR-023 containment). The
  // double reproduces the child's login → create → verify sequence, so each
  // scenario below still describes the failure it always described.
  return new AnyListRecipeSaver(fakeChildRunner({ ...options, createdId: "recipe-id" }).run);
}

const SCENARIOS: Record<keyof typeof SCENARIO_TO_CODE, FakeOptions> = {
  loginThrows: { loginError: new Error("bad credentials") },
  createThrows: { createError: new Error("write rejected") },
  verifyThrows: { verifyError: new Error("read failed") },
  verifyReturnsNull: { verifyResult: null },
  verifyReturnsOtherId: { verifyResult: { id: "someone-elses-recipe" } },
};

async function failureFrom(options: FakeOptions): Promise<AnyListError & { code?: unknown }> {
  const error = await saverFor(options)
    .save(recipe)
    .catch((thrown: unknown) => thrown);

  expect(error).toBeInstanceOf(AnyListError);
  return error as AnyListError & { code?: unknown };
}

describe("the approved code → idempotency-state mapping", () => {
  it("covers every code", () => {
    for (const code of ANYLIST_ERROR_CODES) {
      expect(CODE_TO_STATE[code]).toBeTruthy();
    }
  });

  it("treats only login_failed as safe to retry", () => {
    // "Only login_failed currently carries that evidence." Everything else is
    // AMBIGUOUS, deliberately, because an unnecessary duplicate is unfixable
    // (ADR-021: deleteRecipe reports success without deleting).
    const safe = ANYLIST_ERROR_CODES.filter((code) => CODE_TO_STATE[code] === "FAILED_SAFE");

    expect(safe).toEqual(["login_failed"]);
  });

  it("treats all three write-path codes as ambiguous", () => {
    expect(CODE_TO_STATE.create_failed).toBe("AMBIGUOUS");
    expect(CODE_TO_STATE.verify_unreadable).toBe("AMBIGUOUS");
    expect(CODE_TO_STATE.verify_missing).toBe("AMBIGUOUS");
  });

  it("never lets a createRecipe exception become retryable", () => {
    // The rule ADR-020 exists for: a thrown exception does not prove the write
    // did not land, so it must not license a second attempt.
    const status = OUTCOME_TO_CLAIM_STATUS[CODE_TO_STATE.create_failed];

    expect(mayCallCreateRecipe(REQUIRED_ACTION[status])).toBe(false);
  });

  it("permits exactly one code to reach createRecipe again", () => {
    const retryable = ANYLIST_ERROR_CODES.filter((code) =>
      mayCallCreateRecipe(REQUIRED_ACTION[OUTCOME_TO_CLAIM_STATUS[CODE_TO_STATE[code]]]),
    );

    expect(retryable).toEqual(["login_failed"]);
  });

  it("maps a verification failure to ambiguous, not to a clean failure", () => {
    // The counter-intuitive one. A read-back that found nothing looks like
    // "nothing was written", but eventual consistency means it is not proof.
    expect(CODE_TO_STATE.verify_missing).toBe("AMBIGUOUS");
    expect(mayCallCreateRecipe(REQUIRED_ACTION.ambiguous)).toBe(false);
  });
});

describe("AnyListError redaction still holds alongside the code", () => {
  it("does not leak provider detail", async () => {
    const error = await failureFrom({
      loginError: Object.assign(new Error("login failed for cook@example.com / hunter2"), {
        response: { statusCode: 401 },
      }),
    });

    expect(error.message).not.toContain("cook@example.com");
    expect(error.message).not.toContain("hunter2");
    expect((error as { cause?: unknown }).cause).toBeUndefined();
  });

  it("carries a code on every failure path, so nothing falls through untyped", async () => {
    for (const options of Object.values(SCENARIOS)) {
      const error = await failureFrom(options);

      expect(ANYLIST_ERROR_CODES).toContain(error.code);
    }
  });
});

/**
 * QA-009 RESOLVED. `AnyListError` carries a typed `code` (ADR-020).
 * Activated 2026-08-21.
 */
describe("AnyListError.code — ADR-020", () => {
  it.each(Object.entries(SCENARIO_TO_CODE) as [keyof typeof SCENARIOS, AnyListErrorCode][])(
    "reports %s as %s",
    async (scenario, code) => {
      const error = await failureFrom(SCENARIOS[scenario]);

      expect(error.code).toBe(code);
    },
  );

  it("distinguishes a login failure from a create failure", async () => {
    // The distinction the whole idempotency state machine rests on.
    const login = await failureFrom(SCENARIOS.loginThrows);
    const create = await failureFrom(SCENARIOS.createThrows);

    expect(CODE_TO_STATE[login.code as AnyListErrorCode]).toBe("FAILED_SAFE");
    expect(CODE_TO_STATE[create.code as AnyListErrorCode]).toBe("AMBIGUOUS");
  });

  it("distinguishes an unreadable verification from a missing one", async () => {
    const unreadable = await failureFrom(SCENARIOS.verifyThrows);
    const missing = await failureFrom(SCENARIOS.verifyReturnsNull);

    expect(unreadable.code).toBe("verify_unreadable");
    expect(missing.code).toBe("verify_missing");
  });

  it("reports a timeout on createRecipe as create_failed, not as anything safer", async () => {
    const timeout = Object.assign(new Error("The operation was aborted"), {
      name: "TimeoutError",
    });
    const error = await failureFrom({ createError: timeout });

    expect(error.code).toBe("create_failed");
    expect(CODE_TO_STATE[error.code as AnyListErrorCode]).toBe("AMBIGUOUS");
  });

  it("keeps the code stable and machine-readable, never derived from the message", async () => {
    const error = await failureFrom(SCENARIOS.createThrows);

    expect(ANYLIST_ERROR_CODES).toContain(error.code);
  });
});
