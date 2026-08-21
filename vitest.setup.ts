/**
 * No automated test may make a live third-party call.
 *
 * Every external boundary in this codebase is injectable, so tests *should*
 * never reach the network — but "should" is a convention, and a convention is
 * exactly what a refactor breaks silently. Replacing `fetch` with a throwing
 * stub turns an accidental live call to TikTok, Anthropic, or AnyList into a
 * loud failure instead of a slow, flaky, occasionally-charged test run.
 *
 * A test that genuinely needs to exercise fetch behaviour stubs it locally,
 * which overrides this.
 */
const blocked = (): never => {
  throw new Error(
    "Live network access is blocked in tests. Inject a fake at the boundary instead.",
  );
};

globalThis.fetch = blocked as unknown as typeof fetch;
