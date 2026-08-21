# Production API Test Plan

Test coverage prepared for the contracts frozen in `contracts.md` Part 2 and
**not yet implemented**: `POST /api/imports`, `POST /api/exports/anylist`, and
`Idempotency-Key`.

Last updated: 2026-08-21.

## How the specs are shipped

Each endpoint has one file with two halves.

**Active tripwires** assert the endpoint does not exist: `401` unauthenticated,
`404` authenticated, pipeline never invoked. They pass today and **fail the
moment the route is added**. That is deliberate — it forces whoever implements
the endpoint to open the file and enable the specification rather than ship it
untested.

**A skipped specification** holds the real assertions, written out in full, in a
`describe.skip`. Enabling it is one edit.

| File | Active | Skipped |
|---|---|---|
| `tests/production/imports-endpoint.test.ts` | 5 | 25 |
| `tests/production/exports-anylist-endpoint.test.ts` | 12 | 28 |
| `tests/production/idempotency-contract.test.ts` | 27 | 0 |

`tests/http/current-api.test.ts` carries the third tripwire: "returns no
X-Request-Id header on any response today". Request IDs are a Part 2
requirement, so that test fails when they land.

### What the implementer must provide

Both specs need an injectable dependency, the way `importRecipe` is injectable
on `ServerDeps` today, so route tests never reach TikTok, Anthropic, or AnyList:

- `/api/imports` — an extraction dependency.
- `/api/exports/anylist` — a `RecipeSaver`. The interface already exists
  (ADR-002); it simply is not reachable from `buildServer`.

Designing those seams belongs to the backend. The specs require only that they
exist.

## A. `POST /api/imports`

Covered by the skipped specification:

| Area | Assertions |
|---|---|
| Auth | missing and wrong bearer → `401 Unauthorized` |
| `schemaVersion` | `1` accepted and echoed; missing / null / string / non-integer → `400 Invalid request body`; version `2` → `400 Unsupported schema version` |
| Strict body | unknown key rejected, not ignored (ADR-011); missing, non-string, and malformed `url` rejected |
| Extraction only | full canonical Recipe returned and re-validated with `RecipeSchema`; all ten fields present; no `saved`; no AnyList identifier anywhere in the body |
| Provenance | `source` equals the extracted provenance exactly |
| Request IDs | `requestId` in body; `X-Request-Id` header matches it; a client-supplied `X-Request-Id` is adopted; present on failures too |
| Safe failures | `400 Invalid recipe URL`, `400 Unsupported platform`, `422 Recipe could not be extracted`; no message, stack, or provider detail; body is exactly `{success, error, requestId}` |
| Idempotency | succeeds without a key (optional here); accepting one does not change the response shape |

**Not asserted, and why:** the `500` body (QA-012) and whether a server-issued
recipe identity is returned (QA-013). Both are unresolved — see below.

## B. `POST /api/exports/anylist`

| Area | Assertions |
|---|---|
| `schemaVersion` | as above, plus `400 Unsupported schema version` |
| Strict validation | unknown key rejected at three levels: top-level body, recipe object, and ingredient object |
| Recipe validation | missing/empty title, bad platform, negative servings, confidence > 1, and an *omitted* nullable field each → `400 Invalid recipe` |
| Edited recipes | a recipe the user corrected is accepted and exported under the edited title |
| Warnings | a recipe carrying extraction warnings exports normally — warnings are **never** a rejection reason (ADR-010) |
| No recomputation | `confidence` and `warnings` are not reassessed on export (ADR-010) |
| Provenance | an altered `source.url` is **accepted**, because the invariant is not server-verifiable (ADR-013); shape is still enforced |
| Export | verified AnyList result; `saved.id`; `idempotent: false`; no extraction performed; AnyList failure → `500 Recipe export failed` with nothing leaked |
| Request IDs | as above |
| Idempotency | works without a key; same key + same body replays with `idempotent: true` and the same `saved.id`; same key + different body → `409 Idempotency key conflict`; two concurrent same-key requests → at most one performs the export |

The provenance test is worth calling out. It asserts that the server **accepts**
a tampered `source.url`, because that is what ADR-013 actually decided. Writing
it the other way round would encode a guarantee the system does not make.

Three active tests guard the edited-recipe fixture itself — that it is still a
valid canonical Recipe, that it really differs from the extracted one, and that
its provenance is untouched — so the skipped specs cannot pass for the wrong
reason once enabled.

## C. Idempotency

`tests/production/idempotency-contract.ts` is a **store-agnostic conformance
suite**. It picks no storage technology and implements no endpoint. ADR-012
freezes the semantics and leaves the store to the backend, so the suite is built
to be pointed at whatever gets chosen:

```ts
describe("vercel kv store", () => runIdempotencyStoreConformance({ createStore }));
```

It runs today against a **reference fake** in
`idempotency-contract.test.ts` — an in-memory map that exists only to prove the
suite is coherent and runnable. ADR-012 rules an in-process map out explicitly;
that fake must never move into `src/`.

### The port

Three methods — `claim`, `complete`, `fail` — with `now` passed in so retention
is testable without waiting 24 hours. The **names are a test seam, not a
contract**; the backend may call them anything and adapt. The behaviour is the
frozen part.

### What the suite asserts

- an unseen key is claimed; separate keys are independent; a 255-character key is accepted
- same key + same body while running → `IN_PROGRESS`
- same key + same body after completion → the stored response, replayed
- `FAILED_SAFE` and `AMBIGUOUS` are each reported as themselves
- a `COMPLETED` record is never downgraded to a retryable one
- same key + different body → `conflict`, in every one of the four states
- 20 concurrent claims → **exactly one** wins
- retention: a record just under 24h still replays; a record over 24h is gone,
  and so is its conflict

The last one has a consequence worth stating plainly, because the contract does
not: **after 24 hours the same key with the same body is claimable again, and a
retry will write to AnyList a second time.** Retention is a bound on the
guarantee, not a footnote to it.

### The policy table

`REQUIRED_ACTION` maps each state to what the endpoint must do, and
`mayCallCreateRecipe` is asserted to be true in exactly two states — `NEW` and
`FAILED_SAFE`. Everything else, including `AMBIGUOUS`, is proven not to permit a
write. That is ADR-012's central rule, expressed as something that fails a build.

A separate test asserts the suite does **not** claim exactly-once semantics. The
AnyList API exposes no idempotency key, so a write that landed but whose outcome
we never learned cannot be detected by protocol. `AMBIGUOUS` is the name of that
hole, not a fix for it.

### Today's blocker

`AnyListRecipeSaver` cannot tell `FAILED_SAFE` from `AMBIGUOUS` — every
`createRecipe` failure becomes the same error (QA-009). The state machine above
cannot be populated correctly until it can. This is the one prerequisite the
backend cannot work around, and it is a change to `src/anylist/`, which belongs
to the AnyList research workstream.

## Unresolved contract questions

Recorded in code as `UNRESOLVED_CONTRACT_QUESTIONS` in
`tests/production/contract-gaps.ts`, so resolving one is a deliberate edit
rather than a quiet assumption in a test. Each blocks a specific assertion.

| ID | Question | Blocks |
|---|---|---|
| QA-011 | `IN_PROGRESS` ("Return in-progress") and `AMBIGUOUS` ("Surface for human or client decision") have **no status code and no error string** | Any assertion on a replayed `IN_PROGRESS` or `AMBIGUOUS` key |
| QA-012 | `/api/imports` has no `500` error string; it inherits Part 1's `Recipe import failed`, which names an operation it does not perform | The `500` body for `/api/imports` |
| QA-013 | Whether `/api/imports` returns a server-issued recipe identity is marked open, pending a persistence decision | The full key set of a successful response |
| QA-014 | `409` is defined on "a different request body" without a comparison basis — raw bytes, canonical JSON, or a hash of which fields | That a semantically identical body does not conflict |
| QA-015 | `Idempotency-Key` is "max 255 chars" with no stated behaviour for a longer key | The response to an over-length key |
| QA-016 | "Every response carries `requestId`" sits in Part 2; whether it covers the shared `401`/`404` handlers and the unversioned `POST /api/import` is unstated, and Part 1 says request IDs are not exposed at all | `requestId` on a `401`, a `404`, or any `/api/import` response |
| QA-017 | `FAILED_SAFE` is "safe to retry" — but not whether the *server* retries on replay or returns the stored failure and leaves it to the client | Whether a replayed `FAILED_SAFE` key performs a write |
| QA-018 | The export example returns `saved.name`, but `SaveResult.name` is the submitted title, not a value read back from AnyList | That `saved.name` reflects what AnyList stored |

QA-011, QA-012, and QA-013 are marked `blocks-ios-client`: a thin client
(ADR-004) is defined entirely by the contract it calls, and it cannot handle a
response whose status code is undefined. Two of the five idempotency states are
in that position. These are worth resolving before Wave 1B starts rather than
during it.

QA-014, QA-015, QA-016, and QA-017 are `blocks-backend` — they change what gets
built, not what the client expects. QA-018 is documentation.

None of these is a contradiction in the contract. They are places where it stops
short of being testable, which is exactly what this workstream was asked to
surface rather than fill in.
