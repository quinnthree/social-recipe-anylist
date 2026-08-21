import { describe, expect, it, vi } from "vitest";

import { AnyListError, type AnyListErrorCode, type RecipeSaver } from "../anylist/types.js";
import { validRecipe } from "../test-support/fixtures.js";
import { ExportError, exportRecipe } from "./export-service.js";

function saverThatThrows(error: unknown): RecipeSaver {
  return {
    save: async () => {
      throw error;
    },
  };
}

/** A short budget keeps the timeout cases fast without changing the code path. */
const TEST_TIMEOUT_MS = 20;

async function exportFailure(
  deps: { createSaver: () => RecipeSaver },
  timeoutMs: number = TEST_TIMEOUT_MS,
): Promise<ExportError> {
  const thrown = await exportRecipe(validRecipe, { deps, timeoutMs }).catch(
    (error: unknown) => error,
  );

  expect(thrown).toBeInstanceOf(ExportError);
  return thrown as ExportError;
}

describe("exportRecipe", () => {
  it("returns the verified save result", async () => {
    const deps = {
      createSaver: () => ({ save: async () => ({ name: "Brownies", identifier: "recipe-1" }) }),
    };

    await expect(exportRecipe(validRecipe, { deps })).resolves.toEqual({
      name: "Brownies",
      identifier: "recipe-1",
    });
  });

  it("exports a recipe carrying extraction warnings", async () => {
    // ADR-010: warnings are history, never a reason to refuse an export.
    const save = vi.fn(async () => ({ name: "Brownies", identifier: "recipe-1" }));

    await exportRecipe(
      { ...validRecipe, warnings: ["missing servings", "truncated caption"], confidence: 0.2 },
      { deps: { createSaver: () => ({ save }) } },
    );

    expect(save).toHaveBeenCalledTimes(1);
  });

  it("does not recompute confidence or warnings on the way out", async () => {
    const save = vi.fn(async () => ({ name: "Brownies", identifier: "recipe-1" }));
    const edited = { ...validRecipe, confidence: 0.3, warnings: ["stale warning"] };

    await exportRecipe(edited, { deps: { createSaver: () => ({ save }) } });

    expect(save).toHaveBeenCalledWith(edited);
  });

  describe("AnyList code mapping (ADR-020)", () => {
    it.each([
      ["login_failed", "FAILED_SAFE"],
      ["create_failed", "AMBIGUOUS"],
      ["verify_unreadable", "AMBIGUOUS"],
      ["verify_missing", "AMBIGUOUS"],
    ] as const)("maps %s to %s", async (code: AnyListErrorCode, outcome) => {
      const failure = await exportFailure({
        createSaver: () => saverThatThrows(new AnyListError("AnyList said no.", code)),
      });

      expect(failure.outcome).toBe(outcome);
      expect(failure.code).toBe(code);
    });

    it("classifies on the code, not the message text", async () => {
      // A message that reads like a safe login problem, carrying the code for a
      // call that was actually made.
      const misleading = new AnyListError(
        "AnyList login failed. Check ANYLIST_EMAIL and ANYLIST_PASSWORD in .env.",
        "create_failed",
      );

      expect((await exportFailure({ createSaver: () => saverThatThrows(misleading) })).outcome).toBe(
        "AMBIGUOUS",
      );
    });

    it("treats missing credentials as safe, because nothing reached AnyList", async () => {
      const failure = await exportFailure({
        createSaver: () => {
          throw new AnyListError("Missing AnyList credentials.", "login_failed");
        },
      });

      expect(failure.outcome).toBe("FAILED_SAFE");
    });
  });

  describe("what we refuse to assume", () => {
    it("treats a timeout as AMBIGUOUS, never FAILED_SAFE", async () => {
      // The native client has no cancellation: stopping the wait does not stop
      // the write.
      const failure = await exportFailure({
        createSaver: () => ({ save: () => new Promise<never>(() => undefined) }),
      });

      expect(failure.outcome).toBe("AMBIGUOUS");
      expect(failure.code).toBe("export_timeout");
    });

    it("treats an unrecognised throw from save() as AMBIGUOUS", async () => {
      const failure = await exportFailure({
        createSaver: () => saverThatThrows(new TypeError("unexpected")),
      });

      expect(failure.outcome).toBe("AMBIGUOUS");
      expect(failure.code).toBe("export_unexpected");
    });

    it("treats a construction failure as safe, because it provably precedes the call", async () => {
      const failure = await exportFailure({
        createSaver: () => {
          throw new TypeError("bad wiring");
        },
      });

      expect(failure.outcome).toBe("FAILED_SAFE");
      expect(failure.code).toBe("saver_unavailable");
    });

    it("calls save exactly once and never retries it", async () => {
      const save = vi.fn(async () => {
        throw new AnyListError("boom", "create_failed");
      });

      await exportFailure({ createSaver: () => ({ save }) });

      // The one rule that cannot bend: a duplicate cannot be cleaned up,
      // because deleteRecipe() returns success without deleting (ADR-021).
      expect(save).toHaveBeenCalledTimes(1);
    });
  });

  it("bounds the save with the supplied budget rather than waiting forever", async () => {
    const started = Date.now();

    await exportFailure(
      { createSaver: () => ({ save: () => new Promise<never>(() => undefined) }) },
      30,
    );

    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
