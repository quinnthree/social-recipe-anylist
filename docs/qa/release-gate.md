# QA Release Gate

The checklist to run before the production backend is released. Last updated:
2026-08-21.

Three kinds of check, and they are not interchangeable:

- **AUTOMATED** — `npm test`. Offline, deterministic, runs in seconds. If it is
  not automated it will not be run every time.
- **MANUAL** — a human reads something, or runs a command and inspects the
  output. No external service involved.
- **LIVE EXTERNAL** — really calls TikTok, Instagram, Anthropic, or AnyList.
  Costs money, needs credentials, and is **never** part of the normal suite.

A gate item is either green or the release does not go. "Known issue, shipping
anyway" is a decision for oversight, recorded in `findings.md` — not a QA call.

---

## A. Contract

| # | Check | Kind | Where |
|---|---|---|---|
| A1 | Canonical Recipe validates: required fields, nullable-but-present, constraints, ingredient shape | AUTOMATED | `tests/contract/canonical-recipe.test.ts` |
| A2 | `PlatformSchema.options` is exactly `["tiktok","instagram","youtube"]` | AUTOMATED | same |
| A3 | TimeRange: exact time is `{n, null}`, range keeps both bounds, never `min === max` in the corpus | AUTOMATED | `tests/golden/canonical-recipe.test.ts` |
| A4 | YouTube accepted canonically, refused at ingestion | AUTOMATED | `tests/contract/…`, `tests/golden/ingestion.test.ts` |
| A5 | Every golden Recipe survives a JSON round trip unchanged | AUTOMATED | `tests/golden/canonical-recipe.test.ts` |
| A6 | Inbound strictness in place for any Part 2 endpoint that ships (QA-006) | AUTOMATED once implemented | `tests/production/exports-anylist-endpoint.test.ts` |
| A7 | `contracts.md` Part 1 matches the code that ships | MANUAL | read the diff against the error table |
| A8 | Every unresolved contract question is closed or explicitly deferred | MANUAL | `contract-gaps.ts`, 8 open |

## B. Extraction

| # | Check | Kind | Where |
|---|---|---|---|
| B1 | Recorded payload → `SourceContent` exact, for all 10 ingestible fixtures | AUTOMATED | `tests/golden/ingestion.test.ts` |
| B2 | Confidence and warnings exact, for all 10 extracting fixtures | AUTOMATED | `tests/golden/assessment.test.ts` |
| B3 | Quality baseline holds at 7/9 zero-edit | AUTOMATED | `tests/golden/corpus.test.ts` |
| B4 | Original URL preserved verbatim end to end | AUTOMATED | `tests/golden/ingestion.test.ts` |
| B5 | **The model produces each fixture's `expectedExtraction`** | LIVE EXTERNAL | run `npm run import -- "<url>" --dry-run` per fixture and diff |
| B6 | Instagram still serves Open Graph metadata unauthenticated | LIVE EXTERNAL | one real Reel |
| B7 | Which Instagram interstitials carry an `og:description` (QA-002) | LIVE EXTERNAL | see below |
| B8 | TikTok oEmbed still returns `title` + `author_unique_id` | LIVE EXTERNAL | one real post |

B5 is the only check that verifies extraction quality itself. Everything else in
this section verifies the deterministic code around it. Run B5 whenever the
prompt, the model, or `ExtractedRecipeSchema` changes — those are the three
things that can move it.

## C. AnyList export

| # | Check | Kind | Where |
|---|---|---|---|
| C1 | Mapping: names, times, servings, ingredients, note composition | AUTOMATED | `src/anylist/mapping.test.ts`, `tests/golden/canonical-recipe.test.ts` |
| C2 | `rawText`, `confidence`, `warnings` never transmitted | AUTOMATED | `tests/golden/canonical-recipe.test.ts` |
| C3 | No ingredient is ever dropped | AUTOMATED | same |
| C4 | Range flattened to lower bound, full range preserved in the note | AUTOMATED | same |
| C5 | Save is verified server-side before success is reported | AUTOMATED | `src/anylist/client.test.ts` |
| C6 | `createRecipe` called at most once on every failure path | AUTOMATED | `tests/failure-modes/pipeline-failures.test.ts` |
| C7 | A recipe really appears in the AnyList mobile app, with times in the note | LIVE EXTERNAL | one real save |
| C8 | `prepTime`/`cookTime` zero-persistence bug still present or fixed upstream | LIVE EXTERNAL | AnyList research workstream |

## D. Idempotency

Applies only once `Idempotency-Key` is implemented.

| # | Check | Kind | Where |
|---|---|---|---|
| D1 | The chosen durable store passes the conformance suite | AUTOMATED | `runIdempotencyStoreConformance({ createStore })` |
| D2 | 20 concurrent same-key claims → exactly one winner | AUTOMATED | conformance suite |
| D3 | `mayCallCreateRecipe` true in exactly `NEW` and `FAILED_SAFE` | AUTOMATED | `tests/production/idempotency-contract.test.ts` |
| D4 | 24-hour retention, and expiry after it | AUTOMATED | conformance suite |
| D5 | `FAILED_SAFE` vs `AMBIGUOUS` actually distinguishable at the adapter (QA-009) | AUTOMATED | **blocked** — see `findings.md` |
| D6 | The store survives a process restart and is shared across instances | MANUAL | in-process maps are disqualified by ADR-012 |
| D7 | Concurrency holds against the real store, not just in one process | LIVE EXTERNAL | two concurrent same-key exports |
| D8 | Nothing in the release notes claims exactly-once delivery | MANUAL | ADR-012 |

D5 gates D1. A store that conforms perfectly is useless if the caller cannot
tell it which state to record.

## E. Error handling

| # | Check | Kind | Where |
|---|---|---|---|
| E1 | Every failure kind maps to its documented status and fixed string | AUTOMATED | `tests/http/current-api.test.ts` |
| E2 | Error envelope is exactly `{success, error}` on 400/401/404/422/500 | AUTOMATED | same |
| E3 | Source failures — HTTP 4xx/5xx, reset, DNS, timeout, non-JSON, empty caption | AUTOMATED | `tests/failure-modes/pipeline-failures.test.ts` |
| E4 | Extraction failures — rate limit, overload, unparseable output | AUTOMATED | same |
| E5 | AnyList failures — login, definite create, ambiguous create, verify unreadable, verify missing, id mismatch | AUTOMATED | same |
| E6 | No automatic retry of any external write | AUTOMATED | same |
| E7 | Classification is by error **code**, never by matching message text | AUTOMATED | `src/app/import-service.test.ts` |
| E8 | Oversized body and unsupported media type return a client error (QA-001) | AUTOMATED | **currently fails the intent** — locked as 500 |
| E9 | CLI writes nothing to stdout on any failure | AUTOMATED | `src/index.test.ts` |

## F. Security and logging

| # | Check | Kind | Where |
|---|---|---|---|
| F1 | Server refuses to start without `RECIPE_API_KEY` | AUTOMATED | `src/http/server.test.ts` |
| F2 | Bearer comparison is constant-time and length-blind | AUTOMATED | `src/http/auth.test.ts` |
| F3 | Auth enforced before routing — unknown `/api/` paths are `401`, not `404` | AUTOMATED | `tests/http/current-api.test.ts` |
| F4 | `/health` needs no auth and touches no external service | AUTOMATED | same |
| F5 | No planted secret in any response, on any failure path | AUTOMATED | `tests/http/logging-redaction.test.ts` |
| F6 | No `Authorization` value, API key, AnyList credential, Anthropic key, or token in real pino output | AUTOMATED | same, via child process |
| F7 | Failure logs carry `kind` and `status` only — no provider message, no stack | AUTOMATED | same |
| F8 | Recipe title logged on success; recipe contents are not | AUTOMATED | same |
| F9 | Error text is a fixed string, byte-identical across different inputs | AUTOMATED | same |
| F10 | `.env` is not committed and `.gitignore` still covers it | MANUAL | `git check-ignore .env` |
| F11 | `RECIPE_API_KEY` differs from `ANTHROPIC_API_KEY` and `ANYLIST_PASSWORD` | MANUAL | deployment config |
| F12 | `npm audit` clean; `@anylist-napi/anylist-napi` risk re-reviewed | MANUAL | see `CLAUDE.md` Known Issues |

## G. Vercel deployment

All MANUAL or LIVE EXTERNAL — none of this can be asserted offline.

| # | Check | Kind |
|---|---|---|
| G1 | `GET /health` responds on the deployed URL | LIVE EXTERNAL |
| G2 | Function timeout exceeds observed p95 `elapsedMs`; extraction + export is tens of seconds | MANUAL |
| G3 | Env vars set in Vercel, not baked into the bundle | MANUAL |
| G4 | The native AnyList binary loads in the Vercel runtime | LIVE EXTERNAL |
| G5 | The idempotency store is reachable from every instance and survives restart | LIVE EXTERNAL |
| G6 | Logs reach a destination someone will actually read | MANUAL |
| G7 | The deployment is not publicly discoverable, or the bearer token is strong | MANUAL |

G4 is the one most likely to fail first. The package ships a prebuilt native
binary; nothing about it working locally on macOS proves it works on Vercel's
Linux runtime. Test it before anything else in this section.

## H. Live smoke test

The end-to-end proof, run by hand against real services. Costs a model call and
writes a real recipe.

1. `npm run import -- "<tiktok-url>" --dry-run` → canonical Recipe on stdout,
   nothing else on stdout.
2. Same URL without `--dry-run` → `✓ <name> saved to AnyList`, exit 0.
3. The recipe appears in the AnyList mobile app: name, ingredients with
   quantities, steps in order, source URL, and the stated times in the note.
4. `POST /api/import` against the deployed URL with a valid bearer → `200`,
   `saved.id` present.
5. The same request with a wrong bearer → `401 Unauthorized`.
6. A YouTube URL → `400 Unsupported platform`.
7. An Instagram Reel → either a recipe or `422 Recipe could not be extracted`.
   **Both are passes.** A login wall is designed behaviour, not a failure.
8. Deployed logs for all of the above contain no credential and no provider
   error.

Step 7 is where QA-002 gets checked in the real world: if Instagram returns a
`200` with a login-page description, watch for a junk recipe rather than a
`422`. That outcome is the finding reproducing live, not a flaky test.

---

## Standing rules

- **No live external calls in the automated suite.** `npm test` must stay
  offline and deterministic. `tests/support/fetch-stub.ts` exists for this;
  `forbidNetwork()` turns an accidental live call into an immediate failure.
- **A skipped spec is not coverage.** The `describe.skip` blocks in
  `tests/production/` count for nothing until the tripwire tests fail and
  someone enables them.
- **The corpus baseline is a deliberate edit.** If `npm test` reports the
  quality counts changed, that is the signal, not noise.
