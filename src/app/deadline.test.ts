import { describe, expect, it, vi } from "vitest";

import { Deadline, TimeoutError, withTimeout } from "./deadline.js";

describe("withTimeout", () => {
  it("resolves with the work when it finishes in time", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1_000, "step")).resolves.toBe("ok");
  });

  it("rejects with TimeoutError, naming the operation", async () => {
    const never = new Promise<never>(() => undefined);

    await expect(withTimeout(never, 5, "AnyList export")).rejects.toBeInstanceOf(TimeoutError);
    await expect(withTimeout(never, 5, "AnyList export")).rejects.toThrow("AnyList export");
  });

  it("rejects immediately when there is no budget left", async () => {
    const started = vi.fn();
    const work = new Promise<never>(() => started());

    await expect(withTimeout(work, 0, "step")).rejects.toBeInstanceOf(TimeoutError);
  });

  it("propagates the original error rather than masking it as a timeout", async () => {
    const failure = new Error("underlying");

    await expect(withTimeout(Promise.reject(failure), 1_000, "step")).rejects.toBe(failure);
  });

  it("does not surface a late rejection as an unhandled rejection", async () => {
    let reject: (error: Error) => void = () => undefined;
    const work = new Promise<never>((_resolve, r) => {
      reject = r;
    });

    await expect(withTimeout(work, 5, "step")).rejects.toBeInstanceOf(TimeoutError);

    // The abandoned promise fails after nobody is waiting. Without the internal
    // catch this would take the process down.
    reject(new Error("too late"));
    await new Promise((resolve) => setTimeout(resolve, 5));
  });

  it("abandons the wait but cannot cancel the work", async () => {
    // The property that forces AMBIGUOUS: the AnyList native client exposes no
    // AbortSignal, so a timed-out createRecipe may still land.
    let settled = false;
    const work = new Promise<string>((resolve) => {
      setTimeout(() => {
        settled = true;
        resolve("landed");
      }, 20);
    });

    await expect(withTimeout(work, 5, "AnyList export")).rejects.toBeInstanceOf(TimeoutError);
    expect(settled).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(true);
  });
});

describe("Deadline", () => {
  function clockFrom(start: number): { clock: () => number; advance: (ms: number) => void } {
    let current = start;
    return {
      clock: () => current,
      advance: (ms) => {
        current += ms;
      },
    };
  }

  it("reports what is left", () => {
    const { clock, advance } = clockFrom(1_000);
    const deadline = Deadline.after(100, clock);

    advance(30);
    expect(deadline.remaining()).toBe(70);
  });

  it("never reports a negative remainder", () => {
    const { clock, advance } = clockFrom(1_000);
    const deadline = Deadline.after(100, clock);

    advance(500);
    expect(deadline.remaining()).toBe(0);
    expect(deadline.expired()).toBe(true);
  });

  it("gives a step the smaller of its own budget and what remains", () => {
    const { clock, advance } = clockFrom(1_000);
    const deadline = Deadline.after(100, clock);

    expect(deadline.budgetFor(45)).toBe(45);

    advance(80);
    // The step is not allowed to start a 45 s operation with 20 s left.
    expect(deadline.budgetFor(45)).toBe(20);
  });
});
