# QA

Independent verification for this project. Owned by the QA workstream; it does
not change production source.

Last updated: 2026-08-21.

## Running

```
npm test           # everything. No network, no Anthropic, no AnyList.
npm run typecheck
```

The suite is offline by design. `tests/support/fetch-stub.ts` provides
`forbidNetwork()` and per-fixture stubs; every suite that touches ingestion
installs one, and any URL other than the fixture's own throws. Live checks are
listed in `release-gate.md` and are run by hand.

## Layout

```
fixtures/
  corpus.ts         the golden corpus: 13 fixtures, each an upstream response
                    plus the canonical Recipe it must become
  types.ts          GoldenFixture, the quality classification, expectedRecipe()
  sources/          recorded upstream payloads (TikTok oEmbed JSON, Instagram HTML)

tests/
  golden/           the corpus, asserted end to end around the model boundary
  contract/         the canonical Recipe contract on its own
  http/             the current API, and secret/log redaction
  failure-modes/    every failure the production API must classify
  production/       specs for the frozen-but-unimplemented Part 2 contracts
  support/          fetch stubs, planted secrets, the log-capture child process
```

## The golden corpus

Each fixture records one recorded upstream response and everything it must turn
into. The pipeline has one non-deterministic step — the Claude call — so the
corpus is deliberately split around it:

```
recorded payload → SourceContent → [ MODEL ] → ExtractedRecipe → assessment → Recipe → AnyList payload
└──────── asserted automatically ───────┘              └──────── asserted automatically ────────┘
                                            ▲
                             expectedExtraction: a golden expectation,
                             verified only by a LIVE EXTERNAL check
```

`expectedExtraction` is an expectation, not a recording. No automated test can
prove Claude produces it. What the automated suite does prove is that
*everything either side of it* is exact: ingestion parses the recorded payload
into precisely the expected `SourceContent`, and that expected extraction
produces precisely the expected confidence, warnings, canonical Recipe, and
AnyList payload.

That split is the point. It means a regression anywhere except the model is
caught in 2 seconds offline, and the model's own behaviour has a fixed,
written-down target to be checked against by hand.

### Inventory

| # | Fixture | Platform | What it covers | Class |
|---|---|---|---|---|
| 1 | `tiktok-cottage-cheese-brownies` | TikTok | Known live success; complete recipe, cook-time range | ZERO_EDIT |
| 2 | `tiktok-chicken-tinga` | TikTok | Second complete recipe; exact prep *and* cook time | ZERO_EDIT |
| 3 | `tiktok-missing-servings` | TikTok | No serving count stated | ZERO_EDIT |
| 4 | `tiktok-missing-quantity` | TikTok | Two ingredients with no quantity | ZERO_EDIT |
| 5 | `tiktok-exact-cook-time` | TikTok | Single stated time → `{25, null}` | ZERO_EDIT |
| 6 | `tiktok-cook-time-range` | TikTok | Stated range → `{90, 120}` | ZERO_EDIT |
| 7 | `tiktok-optional-ingredient` | TikTok | "(optional)" with no field to hold it | ZERO_EDIT |
| 8 | `instagram-incomplete-caption` | Instagram | Open Graph description truncated mid-method | EDIT |
| 9 | `tiktok-ingredient-only-in-instructions` | TikTok | Ingredients used but never listed | EDIT |
| 10 | `unsupported-url-pinterest` | — | Unsupported host | FAIL |
| 11 | `instagram-login-wall` | Instagram | Login page, no usable caption — the designed failure | FAIL |
| 12 | `instagram-login-blurb` | Instagram | Login page **with** a description — not rejected (QA-002) | FAIL |
| 13 | `youtube-canonical-not-ingestible` | YouTube | Canonical value exists; ingestion refuses | FAIL |

Fixtures 1–12 cover the twelve scenarios the QA brief asked for. Fixture 12 was
added because writing fixture 11 exposed that the login-wall defence depends
entirely on `og:description` being empty.

### Adding a fixture

1. Save the upstream response verbatim in `fixtures/sources/`.
2. Add a `GoldenFixture` to `fixtures/corpus.ts`. Fill in
   `expectedSourceContent` and either `expectedExtraction` +
   `expectedAssessment` or `expectedFailure`.
3. Run `npm test`. The ingestion and assessment suites will tell you the exact
   values if you guessed wrong — do not reverse-engineer the expectation from
   the output without reading it.
4. Update the baseline counts in `tests/golden/corpus.test.ts`. They are meant
   to require a deliberate edit.

## Quality classification

The North Star is "percentage of extracted recipes that can be saved to AnyList
without requiring user correction". Each fixture carries the answer to *would
the user have to edit this before saving?*

- **ZERO_EDIT_EXPECTED** — every fact the source states is captured correctly and
  nothing is wrong. A field that is null because the source never stated it is
  *faithful*, not an edit.
- **EDIT_EXPECTED** — faithful to the text, but not usable as written without the
  user supplying something.
- **FAIL_EXPECTED** — no recipe should be produced. The pipeline must fail
  cleanly with the stated classification.

**Warnings do not downgrade a fixture.** A warning says what the source lacked,
not what extraction got wrong. Two fixtures are ZERO_EDIT with warnings, and
`tiktok-missing-quantity` scores confidence 1.0 *with* a warning. Anything that
treats a non-empty `warnings` array as a quality failure contradicts ADR-010 and
would reject perfectly good recipes.

### Current baseline

7 of 9 deliverable fixtures are zero-edit — **78%**. (Deliverable = the fixtures
where a recipe should reach the user at all, so the 4 FAIL_EXPECTED ones are
excluded rather than counted as quality failures.)

Asserted in `tests/golden/corpus.test.ts`. The number moving is the signal;
changing it is a deliberate edit, not a side effect.

This is a benchmark, not analytics. There is no event pipeline, no dashboard,
and no per-import tracking — `product-scope.md` rules those out. If per-import
measurement is ever wanted, `confidence`, `warningCount`, and `failureKind` are
already in the telemetry contract and need no new fields.

### What the benchmark shows today

Confidence and the quality classification are **different axes**, and the corpus
demonstrates it: `tiktok-ingredient-only-in-instructions` scores **0.95** and
needs an edit, while `tiktok-missing-servings` scores **0.9** and does not.

The two EDIT_EXPECTED fixtures are the useful ones. Both are cases where
extraction is entirely correct and the recipe is still not ready:

- a caption truncated by Instagram, which the Open Graph warning does flag;
- ingredients used in the method but never listed, which **nothing** flags.

The second is the more important. Inventing "1 bunch sage" would be a worse bug
than omitting it, so the extraction is right — and the user still has to fix the
recipe. A confidence gate (ADR-009) built on today's signals would not catch it.
That is worth knowing before the threshold is chosen.

## Related documents

- `findings.md` — defects and gaps, each reproduced by a test
- `production-api-test-plan.md` — Part 2 endpoint and idempotency test plans,
  and the contract questions that block them
- `release-gate.md` — the pre-release checklist, split AUTOMATED / MANUAL /
  LIVE EXTERNAL
