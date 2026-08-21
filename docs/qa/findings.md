# QA Findings

Independent QA / regression, branch `test/production-regression`.
Last updated: 2026-08-21, against the **final approved production contract**.

Every finding below is reproduced by a test in this repository. None is fixed:
production source is read-only for this workstream.

Severity: **Defect** — wrong in code that ships today. **Gap** — becomes wrong
when an approved-but-unbuilt contract is implemented. **Observation** — worth
knowing, no action implied. **Resolved** — the approved contract settled it.

| ID | Severity | Summary |
|---|---|---|
| QA-001 | Defect | Oversized body → `500`, unsupported media type → `500`; contract now requires `413` / `415` |
| QA-002 | Defect | An Instagram interstitial carrying *any* `og:description` is extracted, not rejected |
| QA-003 | Defect (partly resolved) | No usability gate on `POST /api/import` or the CLI: an empty recipe is saved and reported as success |
| QA-004 | Resolved | `TimeRange` cross-field validation — settled by ADR-024 |
| QA-005 | Gap | The canonical Ingredient cannot express "optional" |
| QA-006 | Resolved | Unknown-key strictness — scoped to the boundary by ADR-024 |
| QA-007 | Resolved (partly) | Whitespace-only `title` — hardened inbound; other strings are not (QA-023) |
| QA-008 | Resolved | `source.url` scheme — restricted to http(s) inbound by ADR-024 |
| QA-009 | Gap | `AnyListError` carries no `code`, so `FAILED_SAFE` and `AMBIGUOUS` cannot be told apart |
| QA-010 | Observation | Log redaction cannot be asserted in-process |
| QA-020 | Defect (new) | `{ n, n }` renders as `"40–40 minutes"` in the AnyList note |
| QA-021 | Gap (new) | 24-hour retention contradicts "a stale `IN_PROGRESS` must not become retryable" |
| QA-022 | Observation (new) | "`X-Request-Id` on every response, no exceptions" vs `GET /health` |
| QA-023 | Gap (new) | Only `title` is hardened against whitespace; every other string shares the weakness |
| QA-024 | Observation (new) | Native stderr leaks `set-cookie` on failed AnyList login — outside our redaction boundary |

---

## QA-001 — Client errors are reported as server errors

**Severity:** Defect. **Reproduced by:** `tests/http/current-api.test.ts`,
"QA-001: reports a body over the 8 KB limit as a 500, not the approved 413" and
"QA-001: reports the unsupported media type %s as a 500, not the approved 415".

`src/http/server.ts:111` maps anything that is not exactly `400` to `500`:

```ts
await fail(reply, statusCode === 400 ? 400 : 500, safeTextFor(statusCode));
```

Fastify raises `FST_ERR_CTP_BODY_TOO_LARGE` with `statusCode: 413` and
`FST_ERR_CTP_INVALID_MEDIA_TYPE` with `415`. Both collapse to
`500 Recipe import failed`, logged at error level.

Verified: `application/xml`, `application/x-www-form-urlencoded`, and
`application/octet-stream` all return `500`. `text/plain` does not — Fastify has
a default parser for it, so it reaches the Zod schema and correctly returns
`400`.

**Now an approved contract divergence, not just a judgement call.** The contract
requires `413 Request body too large` and `415 Unsupported content type`, and
sets per-route body limits (8 KB for both import routes, 64 KB for the export
route). Specification in the `describe.skip` block at the foot of the same file.

## QA-002 — An Instagram interstitial with a description is extracted

**Severity:** Defect. **Reproduced by:** the `instagram-login-blurb` fixture and
`tests/social/instagram-hardening.test.ts`.

The adapter's entire test for a login wall is whether `captionFrom` returns null
(`src/social/instagram.ts:48`). Any interstitial carrying description text — a
sign-in blurb, an age gate, a region notice — passes, and its boilerplate is
sent to Claude as if it were a caption.

The approved hardening names this directly: "never pass arbitrary interstitial
description text to the recipe model as though it were a creator caption". Not
implemented.

Costs: a paid model call for text knowably not a recipe, and (via QA-003) a junk
recipe in the user's AnyList account.

The clean-failure case — a login wall with no usable description — works exactly
as documented and is fixture `instagram-login-wall`.

## QA-003 — No usability gate on the endpoint that ships today

**Severity:** Defect, partly resolved. **Reproduced by:**
`tests/http/current-api.test.ts`, "the minimum-usable-recipe gate does not cover
this endpoint".

ADR-019 introduced the minimum usable recipe — non-blank title, ≥1 ingredient,
≥1 instruction — and applied it to **`POST /api/imports` only**. That endpoint
does not exist yet.

`POST /api/import` is unversioned, explicitly remains in the contract for CLI
and internal use, and received **no gate**. So on the route that actually ships:

```json
{"success":true,"recipe":{"title":"Instagram Login Page","confidence":0.1,"warnings":[…6…]},"saved":{"id":"…"}}
```

`success: true`, confidence 0.1, six warnings, an empty recipe written to
AnyList — and, because `deleteRecipe()` is unreliable (ADR-021), not removable
programmatically. The same applies to `npm run import`.

Applying the structural minimum to `POST /api/import` and the CLI is a small,
already-approved rule reaching one more call site. It needs oversight sign-off
because it adds a failure mode to a Part 1 contract.

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

## QA-009 — `AnyListError` carries no code

**Severity:** Gap. **Reproduced by:**
`tests/production/anylist-error-contract.test.ts`, "AnyListError — not yet
typed".

ADR-020 specifies `code: "login_failed" | "create_failed" | "verify_unreadable"
| "verify_missing"`, and the application mapping `login_failed → FAILED_SAFE`,
all three others → `AMBIGUOUS`.

Not implemented. Every failure still becomes the same `AnyListError` with a
fixed message and no code, so login failure and create failure are
indistinguishable — and the error envelope forbids classifying on message text.

This is the **one prerequisite the backend cannot work around**: without it the
idempotency state machine cannot record the right state, and `FAILED_SAFE` —
the only retryable state — cannot be identified. It is a change to
`src/anylist/`, owned by the AnyList research workstream.

The mapping table itself is asserted today (it is a contract, not code), and the
scenario→code specs are written and skipped.

## QA-010 — Log redaction cannot be asserted in-process

**Severity:** Observation. **Worked around by:**
`tests/http/logging-redaction.test.ts` and `tests/support/log-capture.child.ts`.

`ServerDeps.logger` is `boolean`, and pino writes to fd 1 via `sonic-boom`,
bypassing `process.stdout.write`. The workaround runs the real server in a child
process driven by `app.inject()` — no port opened — and reads its stdout. Full
coverage; about 2 seconds per run. Widening `logger` to accept a stream would
make it a normal assertion, but is not needed.

## QA-020 — `{ n, n }` renders as a range in the AnyList note

**Severity:** Defect (newly exposed). **Reproduced by:**
`tests/contract/inbound-hardening.test.ts`, "DEFECT QA-020: renders { n, n } as
the range \"40–40 minutes\"".

ADR-024 flagged this and asked QA to confirm it. Confirmed.

`describeTime` in `src/anylist/mapping.ts:58` treats any non-null `maxMinutes`
as a range:

```ts
return time.maxMinutes === null
  ? `${time.minMinutes} minutes`
  : `${time.minMinutes}${EN_DASH}${time.maxMinutes} minutes`;
```

So the newly-legal inbound shape `{ minMinutes: 40, maxMinutes: 40 }` produces
`"Cook time stated in source: 40–40 minutes"` in the user's AnyList recipe. Same
for `prepTime`.

Scope: presentational, and reachable only through the inbound export path — our
own extraction still emits `{ n, null }` for an exact time, so nothing today can
produce it. It becomes reachable the moment `POST /api/exports/anylist` ships.
The numeric `cookTime` field is unaffected: it is the lower bound, which for
`{n, n}` is correct.

Fix: `maxMinutes === null || maxMinutes === minMinutes` selects the exact form.
One line in `describeTime`. **Must land with, or before, the export endpoint.**
Specification is the skipped block in the same file.

## QA-021 — Retention contradicts the stale-`IN_PROGRESS` rule

**Severity:** Gap. **Recorded in:** `tests/production/contract-gaps.ts`;
retention behaviour asserted in the conformance suite.

Two approved rules pull against each other:

- ADR-017: retention is **24 hours**.
- ADR-012 as amended: "a stale `IN_PROGRESS` record does not become retryable by
  ageing… Expiry is not evidence of safety."

Within the window the second rule holds and the conformance suite asserts it: a
stale `IN_PROGRESS` becomes `AMBIGUOUS` and is never re-claimed.

At the TTL boundary the record is deleted. The same key with the same
fingerprint is then `NEW`, is claimed, and the export **is** retried — which is
precisely becoming retryable by ageing, at a coarser granularity. A client that
retries a 409 `Export outcome unknown` once a day gets a second write on day two.

This is not necessarily wrong; 24 hours may be the accepted bound on the
guarantee. But it is not stated, and "expiry is not evidence of safety" reads as
though it were absolute. Either the rule needs "within the retention window", or
`AMBIGUOUS` and `IN_PROGRESS` records need retention beyond 24 hours.

No test asserts past-24-hour behaviour for those two states, deliberately.

## QA-022 — `X-Request-Id` on every response vs `GET /health`

**Severity:** Observation. "Every response carries a request ID — 200, 400, 401,
404, 409, 413, 415, 422, and 500 alike, with no exceptions" read literally
includes `GET /health`, which returns no envelope and is the unauthenticated
liveness probe. The specification asserts the header there on the literal
reading, flagged in place. Cheap to confirm either way.

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
