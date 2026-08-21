import { describe, expect, it } from "vitest";

import { fixture } from "../../fixtures/corpus.js";
import { requireRecipe } from "../../fixtures/types.js";
import { AnyListRecipeSaver, type AnyListClientLike } from "../../src/anylist/client.js";
import { AnyListError, type CreateRecipeOptions } from "../../src/anylist/types.js";
import {
  ANYLIST_ERROR_CODES,
  CODE_TO_STATE,
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
  const client: AnyListClientLike = {
    async createRecipe(payload: CreateRecipeOptions) {
      if (options.createError !== undefined) throw options.createError;
      return { id: "recipe-id", name: payload.name };
    },
    async getRecipeById(id: string) {
      if (options.verifyError !== undefined) throw options.verifyError;
      return options.verifyResult === undefined ? { id } : options.verifyResult;
    },
  };

  return new AnyListRecipeSaver(async () => {
    if (options.loginError !== undefined) throw options.loginError;
    return client;
  });
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
    expect(mayCallCreateRecipe(REQUIRED_ACTION[CODE_TO_STATE.create_failed])).toBe(false);
  });

  it("permits exactly one code to reach createRecipe again", () => {
    const retryable = ANYLIST_ERROR_CODES.filter((code) =>
      mayCallCreateRecipe(REQUIRED_ACTION[CODE_TO_STATE[code]]),
    );

    expect(retryable).toEqual(["login_failed"]);
  });

  it("maps a verification failure to ambiguous, not to a clean failure", () => {
    // The counter-intuitive one. A read-back that found nothing looks like
    // "nothing was written", but eventual consistency means it is not proof.
    expect(CODE_TO_STATE.verify_missing).toBe("AMBIGUOUS");
    expect(mayCallCreateRecipe(REQUIRED_ACTION.AMBIGUOUS)).toBe(false);
  });
});

describe("AnyListError — not yet typed", () => {
  it.each(Object.keys(SCENARIOS) as (keyof typeof SCENARIOS)[])(
    "carries no code for %s today",
    async (scenario) => {
      // Tripwire. When AnyListError gains its `code`, these fail and the
      // specification below must be enabled.
      const error = await failureFrom(SCENARIOS[scenario]);

      expect(error.code).toBeUndefined();
    },
  );

  it("still collapses every failure into one indistinguishable kind", async () => {
    // QA-009, restated against the approved contract. login_failed must become
    // FAILED_SAFE and create_failed must become AMBIGUOUS, but the adapter
    // gives the caller nothing to tell them apart beyond a message it must not
    // parse (the error envelope forbids classifying on message text).
    const login = await failureFrom(SCENARIOS.loginThrows);
    const create = await failureFrom(SCENARIOS.createThrows);

    expect(login.code).toBeUndefined();
    expect(create.code).toBeUndefined();
    expect(login).toBeInstanceOf(AnyListError);
    expect(create).toBeInstanceOf(AnyListError);
  });

  it("does not leak provider detail while doing so", async () => {
    // Whatever the code change looks like, this must keep holding.
    const error = await failureFrom({
      loginError: Object.assign(new Error("login failed for cook@example.com / hunter2"), {
        response: { statusCode: 401 },
      }),
    });

    expect(error.message).not.toContain("cook@example.com");
    expect(error.message).not.toContain("hunter2");
    expect((error as { cause?: unknown }).cause).toBeUndefined();
  });
});

/**
 * ENABLE when `AnyListError` gains `code` (ADR-020). Change `describe.skip` to
 * `describe` and delete the tripwire block above.
 */
describe.skip("AnyListError.code — specification (ADR-020)", () => {
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
