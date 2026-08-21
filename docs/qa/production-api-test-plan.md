# Production API Test Plan

Coverage prepared for the **final approved production contract**:
`POST /api/imports`, `POST /api/exports/anylist`, `Idempotency-Key`, request
IDs, the HTTP error contract, canonical input hardening, and typed AnyList
error codes. None of it is implemented.

Last updated: 2026-08-21.

## How the specs are shipped

Each area has active tripwires plus a skipped specification.

**Tripwires** assert the thing does not exist yet — `404` for an unrouted
endpoint, `undefined` for a missing header, no `code` on `AnyListError`. They
pass today and **fail the moment the feature lands**, which forces whoever built
it to enable the specification rather than ship untested.

**Skipped specifications** hold the real assertions in full. Enabling one is a
single edit.

| File | Active | Skipped |
|---|---|---|
| `tests/production/imports-endpoint.test.ts` | 5 | 38 |
| `tests/production/exports-anylist-endpoint.test.ts` | 13 | 53 |
| `tests/production/idempotency-contract.test.ts` | 47 | 0 |
| `tests/production/anylist-error-contract.test.ts` | 13 | 9 |
| `tests/production/contract-gaps.test.ts` | 16 | 0 |
| `tests/contract/inbound-hardening.test.ts` | 54 | 4 |
| `tests/social/instagram-hardening.test.ts` | 12 | 17 |
| `tests/http/current-api.test.ts` | 44 | 12 |

### What the implementer must provide

Injectable dependencies on `ServerDeps`, the way `importRecipe` is injectable
today, so route tests never reach TikTok, Anthropic, AnyList, or Redis:

- `/api/imports` — an extraction dependency.
- `/api/exports/anylist` — a `RecipeSaver` and an `IdempotencyStore`. The
  `RecipeSaver` interface already exists (ADR-002); it is simply not reachable
  from `buildServer`.

Designing those seams is the backend's call. The specs require only that they
exist.

## A. `POST /api/imports`

| Area | Assertions |
|---|---|
| Auth | missing and wrong bearer → `401 Unauthorized` |
| `schemaVersion` | `1` accepted and echoed; missing / null / string / non-integer → `400 Invalid request body`; version `2` → `400 Unsupported schema version` |
| Strict body | unknown key rejected; missing, non-string, malformed `url` rejected |
| Extraction only | full canonical Recipe re-validated with `RecipeSchema`; all ten fields; no `saved`; no AnyList identifier anywhere in the body |
| **Minimum usable recipe** | ≥1 ingredient, ≥1 instruction, non-blank title, else `422 Recipe could not be extracted`; the `instagram-login-blurb` fixture is rejected |
| **Not confidence-gated** | a low-confidence recipe meeting the minimum succeeds; warnings never cause rejection; `confidence` is returned untouched |
| **No durable idempotency** | succeeds with no `Idempotency-Key`; no `idempotent` or `originalRequestId` field; a repeated identical request re-extracts |
| Request IDs | `requestId` in body, matching `X-Request-Id`; a client-supplied value is adopted; present on failures |
| Safe failures | `400 Invalid recipe URL`, `400 Unsupported platform`, `422`; body is exactly `{success, error, requestId}`; nothing leaked |
| Limits | `413 Request body too large` above 8 KB; `415 Unsupported content type` |

The minimum-usable-recipe block is the important addition. It is asserted as
**structural**: five cases (no ingredients, no instructions, neither, blank
title, empty title) each produce `422`, and two cases prove confidence takes no
part in the decision. That is ADR-019 expressed as tests — and it is the fix for
QA-003, on this endpoint only.

## B. `POST /api/exports/anylist`

| Area | Assertions |
|---|---|
| `schemaVersion` | as above, plus `400 Unsupported schema version` |
| Strict validation | unknown key rejected at four levels: body, recipe, ingredient, source |
| Recipe validation | missing/empty title, bad platform, negative servings, confidence > 1, omitted nullable → `400 Invalid recipe` |
| Edited recipes | a corrected recipe is accepted and exported under the edited title |
| Warnings | a recipe carrying warnings exports normally — never a rejection reason (ADR-010) |
| No recomputation | `confidence`/`warnings` are not reassessed |
| Provenance | an altered `source.url` is **accepted** — the invariant is not server-verifiable (ADR-013); shape still enforced |
| **Idempotency-Key required** | missing, empty, or >128 chars → `400 Invalid idempotency key`; 128 exactly accepted; no AnyList write when the key is invalid |
| **Replay** | `idempotent: false` first, `true` on replay, same `saved.id`; `originalRequestId` absent first, present on replay, different from `requestId` |
| **Fingerprint** | a re-serialised identical recipe with reordered keys replays rather than conflicting |
| **409s** | `Idempotency key conflict`, `Export already in progress`, `Export outcome unknown`; every 409 carries a `requestId` |
| **FAILED_SAFE retry** | a login failure is retried and succeeds; an ambiguous outcome is never retried |
| Inbound hardening | whitespace title, non-http `source.url`, `max < min` → `400 Invalid recipe`; `max === min` accepted |
| Limits | 64 KB allowed, `413` above it, `415` for non-JSON |

Two assertions are worth calling out because they encode decisions rather than
mechanics:

- **The provenance test asserts the server *accepts* a tampered `source.url`.**
  That is what ADR-013 decided. Writing it the other way round would encode a
  guarantee the system does not make.
- **"does not render an accepted `{ n, n }` cook time as a range"** is the
  consumer-visible half of QA-020, and will fail until `describeTime` is fixed.

Three active tests guard the edited-recipe fixture itself, so the skipped specs
cannot pass for the wrong reason once enabled.

## C. Idempotency

`tests/production/idempotency-contract.ts` is a **store-agnostic conformance
suite**. ADR-017 selects Upstash Redis behind an `IdempotencyStore`
abstraction; the suite is written against the smallest port those semantics
need, so it can be pointed at the real store:

```ts
describe("upstash store", () => runIdempotencyStoreConformance({ createStore, staleAfterMs }));
```

It runs today against a **reference fake** — an in-memory map that exists only
to prove the suite is coherent. ADR-012 rules an in-process map out explicitly;
that fake must never move into `src/`.

### What the store suite asserts

- an unseen key is claimed; keys are independent; a 128-character key is accepted
- same key + same fingerprint while running → `IN_PROGRESS`
- after completion → the recorded result, including the originating `requestId`
- **`FAILED_SAFE` is re-claimed** so the export retries — the amended rule
- **`AMBIGUOUS` is never re-claimed**
- a `COMPLETED` record is never downgraded to a retryable one
- same key + different fingerprint → `conflict`, in all four states, including
  over a `FAILED_SAFE` record
- **20 concurrent claims → exactly one winner**, and separately **10 concurrent
  re-claims of a `FAILED_SAFE` record → exactly one winner** (the transition
  most easily made non-atomic by accident)
- a stale `IN_PROGRESS` is **never** returned as claimable, and is reported as
  `AMBIGUOUS`
- retention: just under 24h replays; over 24h is gone

### Fingerprint (ADR-018)

`runFingerprintConformance` asserts a SHA-256 hex digest, stability, key-order
independence, encoding-whitespace independence, sensitivity to any value change,
and — importantly — that **ingredient and instruction order are significant**. A
normalisation that sorted arrays would make two different recipes share a
fingerprint, and the second export would be silently swallowed as a replay.

### Policy table

`REQUIRED_ACTION` maps each state to an action; `mayCallCreateRecipe` is
asserted true in exactly `NEW` and `FAILED_SAFE`. `REQUIRED_RESPONSE` pins
`409` and its three distinct error strings. Every rejecting state is asserted to
be a `409`.

### Blocker

`AnyListError` has no `code` (QA-009), so the state machine cannot be populated
correctly. **This gates the whole idempotency implementation.**

## D. AnyList error classification

`tests/production/anylist-error-contract.ts` holds the ADR-020 mapping as data.
Assertable today because it is a contract, not code:

- every code has a state
- **only `login_failed` is `FAILED_SAFE`** — asserted as an exact list, so
  adding a retryable code is a deliberate edit
- all three write-path codes are `AMBIGUOUS`
- a `createRecipe` exception can never become retryable
- exactly one code may reach `createRecipe` again

The scenario→code specs (`loginThrows → login_failed`,
`createThrows → create_failed`, `verifyThrows → verify_unreadable`,
`verifyReturnsNull` / `verifyReturnsOtherId → verify_missing`) are skipped, plus
a spec that a `createRecipe` timeout is `create_failed` and nothing safer.

## E. Instagram hardening

`tests/social/instagram-hardening.test.ts`. Active tests record why the approved
policy cannot exist yet: the adapter passes `redirect: "follow"`, so undici
resolves the whole chain and exactly one request is observable — there is no hop
to validate. It also never reads `response.url`, so it trusts a body without
checking where it came from, which an active test demonstrates.

Skipped specification covers the approved policy: same-policy redirect followed;
relative and protocol-relative `Location` resolved; external, lookalike-host,
and http-downgrade redirects rejected **before the off-policy destination is
requested**; empty, non-URL, `javascript:`, and `data:` `Location` values
rejected; a 3xx with no `Location`; a bounded chain; a self-referential loop;
a redirect to the login wall; and an interstitial description rejected rather
than treated as a caption — the fix for QA-002 — with no Anthropic call made.

Implementing this needs `redirect: "manual"`, at which point the chain becomes
several observable fetches and the assertions become meaningful.

## Contract questions

Recorded in `tests/production/contract-gaps.ts` with `resolved` and `resolution`
fields, and asserted by `contract-gaps.test.ts`.

**Six of eight resolved by the approved contract:**

| ID | Resolution |
|---|---|
| QA-011 | `409 Export already in progress` / `409 Export outcome unknown`. All five states now have a defined response. |
| QA-012 | Error strings assigned by route: `Recipe import failed` / `Recipe export failed`. |
| QA-014 | ADR-018 fingerprint: validate → normalise → serialise → SHA-256. Raw bytes never compared. |
| QA-015 | Length 1–128, required on the export route, `400 Invalid idempotency key`. |
| QA-016 | "Every response… with no exceptions." `X-Request-Id` always. |
| QA-017 | The server re-claims: `FAILED_SAFE → IN_PROGRESS` atomic, then retry. |

**Five open:**

| ID | Question | Severity |
|---|---|---|
| QA-013 | Whether `/api/imports` returns a server-issued recipe identity — still marked open, pending a persistence decision | blocks-ios-client |
| QA-018 | No response field reflects what AnyList *stored*: `saved.name` is the submitted title and `saved.id` is client-generated (ADR-021) | documentation |
| QA-021 | 24-hour retention vs "a stale `IN_PROGRESS` must not become retryable" | blocks-backend |
| QA-022 | "`X-Request-Id` on every response, no exceptions" vs `GET /health` | documentation |
| QA-023 | Only `title` is hardened against whitespace; every other string shares the weakness | blocks-backend |

QA-013 is the last one blocking the iOS client. QA-021 is the one worth
resolving before the export endpoint ships, because it changes what the
guarantee actually means at the boundary.
