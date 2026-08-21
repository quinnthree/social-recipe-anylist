# QA Findings

Independent QA / regression, reconciled against the **milestone 4 integration**
(main through `b87eb6c`, backend through `137c68c`).
Last updated: 2026-08-21.

Every finding is reproduced by a test in this repository, or recorded as
resolved with the test that now proves the fix.

Severity: **Defect** — wrong in code that ships today. **Gap** — becomes wrong
when an approved-but-unbuilt contract is implemented. **Observation** — worth
knowing. **Resolved** — fixed in the integrated build or settled by contract.

| ID | Status | Summary |
|---|---|---|
| QA-001 | **Resolved** | `413 Request body too large` and `415 Unsupported content type` are now returned |
| QA-002 | **Resolved** | Instagram interstitials are rejected before any model call |
| QA-003 | **Resolved** | The usability gate moved to the shared import-service boundary, covering the legacy route and the CLI |
| QA-004 | Resolved | `TimeRange` cross-field validation — settled by ADR-024 |
| QA-005 | Gap | The canonical Ingredient still cannot express "optional" |
| QA-006 | Resolved | Unknown-key strictness — scoped to the boundary by ADR-024, enforced inbound |
| QA-007 | Resolved (partly) | Whitespace-only `title` hardened inbound; other strings are not (QA-023) |
| QA-008 | Resolved | `source.url` restricted to http(s) inbound |
| QA-009 | **Resolved** | `AnyListError` carries a typed `code`; only `login_failed` is retryable |
| QA-010 | Resolved | `logDestination` is injectable, so redaction is asserted in-process |
| QA-020 | **Resolved** | `{ n, n }` renders as an exact time, not `"40–40 minutes"` |
| QA-021 | **Resolved** | Retention is state-dependent (ADR-025); uncertainty outlives settled state |
| QA-022 | **Resolved** | `X-Request-Id` is set on every response, `/health` and 404s included |
| QA-023 | Gap | Only `title` is hardened against whitespace; every other string shares the weakness |
| QA-024 | Observation | Native stderr leaks `set-cookie` on failed AnyList login — outside our redaction boundary |
| QA-025 | **Defect (new, minor)** | `isUsableRecipe` trims the title but counts blank ingredients and instructions |
| QA-026 | Observation (new) | `requestId` is in the envelope only on production routes, not "wherever an envelope is returned" |
| QA-027 | Observation (new) | Unauthenticated callers can distinguish a registered route (401) from an unregistered one (404) |

---

## QA-001 — RESOLVED: client errors now report as client errors

**Was:** the error handler mapped anything that was not exactly `400` to `500`,
so an oversized body and an unsupported media type both came back as
`500 Recipe import failed`.

**Now:** `kindForFastifyCode` classifies on the Fastify error **code**, and the
contract's `413 Request body too large` and `415 Unsupported content type` are
returned on every route. The default `text/plain` parser is removed, so a wrong
content type is an honest media-type refusal rather than a confusing complaint
about the body.

Verified in `tests/http/current-api.test.ts` and both endpoint specs, including
per-route limits: 8 KB on the import routes, 64 KB on the export route.

## QA-002 — RESOLVED: interstitials are rejected before the model call

**Was:** the adapter's only test for a login wall was an empty `og:description`,
so any interstitial carrying description text was sent to Claude as a caption.

**Now:** `interstitialReason` checks three independent deterministic signals —
a path that is never a post, an `og:title` only a non-post page produces, and
description metadata matching Instagram's own boilerplate — before any text is
read as a caption. The `instagram-login-blurb` fixture is now a FAIL fixture:
it is refused after exactly one HTTP request and no model call.

The false-positive guard matters as much as the detection, and is asserted: a
real post with a genuine caption still extracts.

## QA-003 — RESOLVED, and better than proposed

**Was:** ADR-019's minimum usable recipe gated `POST /api/imports` only. That
endpoint did not exist, and the route that actually shipped — `POST /api/import`,
plus the CLI — had no gate at all, so an empty recipe was written to AnyList and
reported as `success: true`.

**Now:** the gate lives at the shared **import-service boundary**, not in a
route handler, so it covers `/api/imports`, the legacy `/api/import`, and the
CLI alike. That is the stronger fix: the legacy path is the one that writes to
AnyList, so it was the wrong one to hold to a weaker standard.

Verified in `tests/failure-modes/pipeline-failures.test.ts`: an extraction with
no ingredients, no instructions, or a blank title is `extraction_failed`, and
the AnyList saver is never constructed. Confidence still takes no part in the
decision — a 0.1-confidence recipe that meets the minimum exports normally.

See QA-025 for the one edge the gate does not cover.

## QA-004 — RESOLVED

ADR-024: inbound accepts `maxMinutes === minMinutes` and rejects
`maxMinutes < minMinutes`. `TimeRangeSchema` stays permissive as a producer
schema. Asserted in `tests/contract/inbound-hardening.ts`. Accepting `{n, n}`
exposed QA-020.

## QA-005 — The canonical Ingredient cannot express "optional"

**Severity:** Gap. **Reproduced by:** `tiktok-optional-ingredient` and
`tests/golden/canonical-recipe.test.ts`.

"1/2 cup roasted peanuts (optional)" has two possible homes: `rawText`, which
the adapter drops, and `preparation`, which reaches AnyList as the ingredient
note. Nothing requires the model to use the latter, so whether the user's recipe
says "optional" rests on a model choice no schema constrains.

Unchanged by this revision. Adding an `optional` field is an ADR-008 decision.

## QA-006 — RESOLVED

ADR-024 scoped strictness to untrusted inbound consumer-API data rather than
making every internal Zod object strict. `RecipeSchema` stripping unknown keys
is now correct for a producer schema. The inbound suite asserts rejection at
four levels: body, recipe, ingredient, source, and time range.

## QA-007 — RESOLVED for `title`, open for everything else

ADR-024 A rejects whitespace-only titles inbound. It covers `title` only — see
QA-023.

## QA-008 — RESOLVED

ADR-024 B restricts inbound `source.url` to `http:` and `https:`. Asserted in
the inbound suite; the producer schema stays permissive, which is safe because
`detectPlatform` rejects non-http schemes on the extraction path.

## QA-009 — RESOLVED: AnyList errors are typed

**Was:** every AnyList failure became the same untyped `AnyListError`, so
`login_failed` and `create_failed` were indistinguishable — and the error
envelope forbids classifying on message text. This blocked the idempotency
state machine.

**Now:** `AnyListError` carries
`code: "login_failed" | "create_failed" | "verify_unreadable" | "verify_missing"`,
and the application maps it (ADR-020): `login_failed → FAILED_SAFE`, the other
three → `AMBIGUOUS`. The adapter reports facts; the application decides retry
safety.

Verified end to end in `tests/production/anylist-error-contract.test.ts`: each
scenario produces its code, a `createRecipe` timeout is `create_failed` and
nothing safer, and exactly one code can reach `createRecipe` again.

## QA-010 — RESOLVED: redaction is assertable in-process

`ServerDeps.logDestination` is now injectable, so the real Pino output can be
captured and asserted without a child process. The subprocess capture in
`tests/http/logging-redaction.test.ts` still runs as an independent check of
what the deployed configuration actually writes, which is a slightly different
claim and worth keeping.

The redaction path list also widened: `authorization`, `cookie`, `x-api-key`,
`idempotency-key`, and `*.password` / `*.token` / `*.accessToken` /
`*.refreshToken` / `*.apiKey`.

**Bounded by QA-024**, which no in-process assertion can reach.

## QA-020 — RESOLVED: `{ n, n }` renders as an exact time

**Was:** `describeTime` treated any non-null `maxMinutes` as a range, so the
inbound-legal `{ minMinutes: 40, maxMinutes: 40 }` produced
`"Cook time stated in source: 40–40 minutes"` in the user's AnyList recipe.

**Now:** a range is `maxMinutes > minMinutes`, so `{ 40, 40 }` and
`{ 40, null }` render identically. The user cannot tell which encoding their
client happened to send.

Verified in `tests/contract/inbound-hardening.test.ts` and asserted through the
export endpoint.

## QA-021 — RESOLVED: retention is state-dependent

**Was:** a flat 24-hour retention contradicted "a stale `IN_PROGRESS` must not
become retryable by ageing". At the TTL boundary the record would be deleted,
the key would read as unseen, and a retry would write a second time.

**Now:** ADR-025 splits retention by state — `COMPLETED` and `FAILED_SAFE` keep
24 hours, `IN_PROGRESS` and `AMBIGUOUS` keep 30 days — and a stale lease
transitions the record to `AMBIGUOUS` rather than deleting it. TTL is not a
lease, and uncertainty is preserved rather than erased.

Verified against the real store in
`tests/production/idempotency-contract.test.ts`.

## QA-022 — RESOLVED: the header really is on every response

An `onSend` hook sets `X-Request-Id` on every response, including `GET /health`
and 404s. The literal reading was implemented. See QA-026 for the envelope,
which is a narrower claim.

## QA-023 — Only `title` is hardened against whitespace

**Severity:** Gap. **Reproduced by:** `tests/contract/canonical-recipe.test.ts`,
"accepts a whitespace-only title; the inbound schema rejects it".

ADR-024 A hardens `title`. Every other `.min(1)` string in the canonical Recipe
has the identical weakness and is not covered: ingredient `name` and `rawText`,
`quantity`, `unit`, `preparation`, and instruction steps.

An ingredient named `"   "` passes inbound validation and reaches the user's
AnyList shopping list as a blank line. That is a more visible failure than a
blank title, since ingredients become shopping-list entries.

The reference inbound schema deliberately implements only what ADR-024 states,
so the suite does not assert a rule that was not approved.

## QA-024 — Native stderr is outside the redaction boundary

**Severity:** Observation. **Source:** ADR-023, RESEARCH-PROVEN by the AnyList
workstream; not independently reproduced here (it needs a real failed login).

On failed login the native library writes response metadata — including
`set-cookie` values — straight to stderr, before any JavaScript logging can
intercept it.

This bounds what `tests/http/logging-redaction.test.ts` proves. That suite
asserts our pino output is clean, and it is: no `Authorization` value, no API
key, no AnyList credential, no Anthropic key, no provider message, no stacks.
It says nothing about a native library writing to a file descriptor, and it
cannot.

Added to the release gate as a LIVE EXTERNAL check. The Milestone 2 migration
removed the console-interception shim, so there is currently no JavaScript-side
interception of native output at all.

## QA-025 — `isUsableRecipe` counts blank ingredients and instructions

**Severity:** Defect, minor and newly exposed. **Reproduced by:**
`tests/failure-modes/pipeline-failures.test.ts`, the two `QA-025` tests.

`isUsableRecipe` applies `.trim()` to the title and a bare `.length > 0` to the
two arrays:

```ts
recipe.title.trim().length > 0 &&
recipe.ingredients.length > 0 &&
recipe.instructions.length > 0
```

So a recipe whose only instruction is `"   "`, or whose only ingredient is named
`"   "`, counts as usable and reaches the AnyList write.

Literally conformant with ADR-019 — "at least one instruction", and `"   "` is
one — but not what "can a person actually cook from this" means. That the title
*is* trimmed is what makes the other two look like an oversight rather than a
decision.

Low reachability: the model is prompted for real instructions, and the inbound
export path does not use this gate. Not deployment-blocking. The fix is two
`.some(…trim().length > 0)` checks, and it is a contract decision rather than a
QA one, because it narrows what ADR-019 admits.

Same root weakness as QA-023.

## QA-026 — `requestId` is in the envelope only on production routes

**Severity:** Observation. **Recorded in:** `tests/http/current-api.test.ts`,
"leaves requestId out of the frozen Part 1 envelopes".

The contract says `requestId` appears in the JSON envelope "wherever an envelope
is returned", with no exceptions. The implementation puts it in the envelope on
`/api/imports` and `/api/exports/anylist` only; `POST /api/import` and the
not-found handler keep their Part 1 bodies byte-for-byte, on the stated grounds
that Part 1 is frozen and the CLI depends on it.

Both still carry the `X-Request-Id` header, so nothing is un-correlatable.

This is a defensible reading of two rules that genuinely conflict — "Part 1 is
frozen" against "every envelope carries requestId" — and the choice is
documented in the source. It needs a one-line ruling in `contracts.md`, not a
code change. Flagged rather than asserted either way.

## QA-027 — Registered and unregistered routes are distinguishable unauthenticated

**Severity:** Observation. **Recorded in:** `tests/http/current-api.test.ts`,
"answers 404, not 401, for a path no route is registered at".

Authentication is now applied over *registered* routes: an unmatched path falls
to the not-found handler and answers `404 Not found` without an auth check,
which is what keeps Part 1's frozen 404 behaviour intact. The previous
implementation checked the `/api/` prefix and answered `401` for everything
under it.

Consequence: an unauthenticated caller can tell a registered route (`401`) from
an unregistered one (`404`). The route set is public in `contracts.md`, so this
discloses nothing secret, and the allowlist design it comes from is a genuine
improvement — `PUBLIC_PATHS` makes authentication deny-by-default rather than
dependent on where a route happens to be mounted.

Recorded so the trade is visible, not as a finding to fix.

---

## Not findings

Checked and correct:

- **Auth runs before routing.** Unauthenticated requests to unknown `/api/`
  paths return `401`, not `404`.
- **`createRecipe` is never called more than once** on any failure path.
- **A dry run never constructs the AnyList adapter.**
- **No Anthropic call is made when ingestion fails.**
- **Error text is a fixed string chosen by status**, byte-identical across
  different inputs producing the same failure.
- **Timing-safe bearer comparison**, length-blind.
- **The canonical/ingestion platform split holds.**
- **Pino output carries no secret**, across every failure path — within the
  boundary QA-024 describes.
