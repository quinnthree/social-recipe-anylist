# Contracts

This document has three parts.

- **Part 1 — CURRENT** describes the original proof endpoint and CLI.
- **Part 2 — IMPLEMENTED** describes the production API. As of Milestone 4 it is
  **built, tested, and merged** — it is no longer a proposal. What remains
  outstanding is **live deployment verification**, not implementation.
- **Part 3 — APPROVED, NOT IMPLEMENTED** describes consumer authentication.
  The decision is made and the contract is fixed; **none of it exists in code.**
- **RESEARCH-PROVEN** marks measured findings from the AnyList and QA
  workstreams. These are observations about the world, not statements about our
  code. They appear inline where relevant and in full in `architecture.md`.

Every claim in this document is tagged with one of those four. If something is
untagged, treat it as CURRENT.

Last updated: 2026-08-24.

---

# Part 1 — CURRENT (implemented)

Verified against the code on 2026-08-21.

## CLI

```
npm run import -- "<url>"              extract → save to AnyList → print success
npm run import -- "<url>" --dry-run    extract → print canonical Recipe JSON, no AnyList
```

Success prints exactly one line to stdout:

```
✓ <Recipe Name> saved to AnyList
```

Printed only after AnyList has verified the save server-side. Errors go to
stderr; stdout stays empty on failure; exit code is 1.

## `GET /health`

Unauthenticated. Proves the process is alive and nothing else — it makes no
Anthropic, TikTok, Instagram, or AnyList calls.

```
200  {"status":"ok"}
```

## `POST /api/import`

**One-shot: extracts and saves to AnyList in a single synchronous call.**

```
Authorization: Bearer <RECIPE_API_KEY>
Content-Type: application/json

{ "url": "https://www.tiktok.com/..." }
```

Body schema is `z.object({ url: z.string().url() }).strict()`. Body limit 8 KB.

**200** — returned only after `getRecipeById` confirms the recipe exists in the
AnyList account:

```json
{
  "success": true,
  "recipe": { "title": "...", "confidence": 0.9, "warnings": ["..."] },
  "saved": { "id": "<anylist-recipe-id>" }
}
```

The full canonical Recipe is deliberately **not** returned.

### Error envelope

Every failure, including 404s and unexpected throws:

```json
{ "success": false, "error": "<fixed string>" }
```

| Condition | Status | `error` |
|---|---|---|
| Missing/invalid bearer token | 401 | `Unauthorized` |
| Malformed body, bad URL, extra keys | 400 | `Invalid request body` |
| URL unparseable or non-http(s) | 400 | `Invalid recipe URL` |
| Host is not TikTok/Instagram | 400 | `Unsupported platform` |
| No caption, login wall, model failure | 422 | `Recipe could not be extracted` |
| AnyList failure, or anything unexpected | 500 | `Recipe import failed` |
| Unknown route | 404 | `Not found` |

No stack traces, provider errors, credentials, tokens, or request internals are
ever returned. Error text is a fixed string chosen by status; the underlying
message is never echoed.

## Canonical Recipe

The shape produced by extraction and printed by `--dry-run`. Optional values are
explicit `null`, never omitted.

```ts
{
  title: string                       // non-empty
  description: string | null
  servings: number | null             // positive integer
  prepTime: { minMinutes: number, maxMinutes: number | null } | null
  cookTime: { minMinutes: number, maxMinutes: number | null } | null
  ingredients: Array<{
    quantity: string | null           // kept verbatim, e.g. "1/2", "2-3"
    unit: string | null
    name: string                      // non-empty
    preparation: string | null
    rawText: string                   // the original line
    alternateMeasurements: Array<{    // null when the creator stated none
      quantity: string                // source text, e.g. "14", "2 to 2.5"
      unit: string | null             // e.g. "oz", "cup"
      descriptor: string | null       // e.g. "sliced", "medium sweet potatoes"
    }> | null
  }>
  instructions: string[]
  source: {
    platform: "instagram" | "tiktok"  // CURRENT code enum.
                                      // Contract (Part 2) is
                                      // "tiktok" | "instagram" | "youtube";
                                      // the enum change is NOT applied.
    creator: string | null
    url: string                       // the original URL, verbatim
  }
  confidence: number                  // 0..1, computed deterministically by us
  warnings: string[]                  // computed deterministically by us
}
```

`maxMinutes: null` means a single stated time. An exact time is never encoded as
`min === max`.

### `alternateMeasurements` — author-provided only

A second measurement **the creator themselves wrote**, alongside the primary
one. `Sweet potatoes — 400g (approx. 14 oz / 2 to 2.5 medium sweet potatoes)`
has a primary of `400` / `g` and two alternates: `14 oz`, and `2 to 2.5` with
the descriptor `medium sweet potatoes`.

- **Never a conversion.** No unit conversion, rounding, density table, or
  scaling may write into this field. If the creator did not state it, it is not
  there. Every alternate is quotable from the ingredient's own `rawText`, which
  is what makes the rule checkable rather than aspirational.
- `quantity` is source text, not a number — `"2 to 2.5"` and `"1/3"` stay as
  written, like the primary quantity.
- `descriptor` qualifies **that alternate**, not the ingredient. The `sliced` in
  `1 cup sliced` says what a cup of mushrooms means; it is not a preparation
  step, and it is not promoted into `preparation`.
- `null` means the creator offered no alternate. Our extraction never emits `[]`.
- `rawText` is unchanged and is never regenerated from these fields. It remains
  the source ground truth, and for some information — `to taste`, a stated
  parenthetical `(optional)` — it is still the only place that survives.

There is deliberately no `kind`, no provenance enum, no `calculated` flag, no
normalised numeric quantity, and no unit enum. The type means exactly one thing,
so a field distinguishing what produced a value would have only one value.

The AnyList adapter does **not** transmit alternates. It sends what it always
sent: name, the primary quantity and unit as one string, and `preparation` as
the note. Alternates are preserved for a later Review projection.

## Authentication

Single static bearer token from `RECIPE_API_KEY`. Compared in constant time
(both sides SHA-256'd first, so neither contents nor length leak). Enforced by an
`onRequest` hook scoped to `/api/*`. The server refuses to start if the key is
missing or empty.

## Environment

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Recipe extraction |
| `ANYLIST_EMAIL`, `ANYLIST_PASSWORD` | AnyList account |
| `RECIPE_API_KEY` | API bearer token; must not reuse the above |
| `PORT`, `HOST` | Default `3000`, `127.0.0.1` |

`OPENAI_API_KEY` and `APIFY_API_TOKEN` exist in `.env.example` from the original
scaffold and are unused.

## Limits of the legacy `POST /api/import` path

These describe the Milestone 3 one-shot endpoint and the CLI. They are **not**
limits of the production API in Part 2, which addresses most of them.

- **Synchronous.** A request runs source fetch + Claude call + AnyList
  save-and-verify. Tens of seconds is normal. **Still true everywhere** — the
  production API is synchronous by design (ADR: no queues in V1).
- **No idempotency on this route.** A client retry after a timeout can create a
  duplicate recipe in AnyList. `POST /api/exports/anylist` has durable
  idempotency; this legacy route does not.
- **No `requestId` in this route's JSON body.** Its envelope is frozen as
  Part 1 documents it. The `X-Request-Id` **header is still sent** — the hook
  that sets it covers every response with no exceptions — which is additive and
  cannot break a client that does not read it.
- **Covered by the usability gate.** As of Milestone 4 this route goes through
  the shared `importRecipe()` boundary, so it no longer writes obviously empty
  recipes (QA-003, ADR-019).
- **Native stderr is not covered by redaction.** RESEARCH-PROVEN and **still
  unresolved**: on failed AnyList login the native library writes response
  metadata — including `set-cookie` values — straight to stderr, before any
  JavaScript logging can intercept it. Pino redaction governs our logs, not a
  native library's file descriptor. This applies to **every** route and blocks
  broad consumer release.

---

# Part 2 — IMPLEMENTED (production API)

**Status: implemented as of Milestone 4** (integration `065d9c6`, branch
`integration/m4`): 1079 tests passing, 28 live-external tests intentionally
skipped, typecheck clean.

**Live deployment verification: PASSED (2026-08-24).** The private Vercel smoke
test exercised every route below against a deployed environment, a live Upstash
instance, live Anthropic parsing, and a real AnyList account. Details in
`handoff.md`.

Two qualifications remain. **Automated** Redis conformance is still live-gated —
the smoke test proved the behaviour by hand, not by suite — and the native
stderr risk (ADR-023) still blocks broad consumer release. Neither is a contract
gap.

## Why split

The native product requires Review/Edit between extraction and export. A
one-shot endpoint cannot express that: the user must see the canonical Recipe,
correct it, and only then commit it to AnyList. `POST /api/import` proved the
pipeline; it should not dictate the iOS contract.

`POST /api/import` **may remain** for CLI and internal use. It is not deprecated
by this proposal. It is simply not what iOS calls.

## A. `POST /api/imports` — extraction

Extracts a canonical Recipe. **Writes nothing to AnyList.**

```
POST /api/imports
Authorization: Bearer <token>
Idempotency-Key: <client-generated>        (optional; see below)
Content-Type: application/json

{ "schemaVersion": 1, "url": "https://www.tiktok.com/..." }
```

**200**

```json
{
  "success": true,
  "schemaVersion": 1,
  "requestId": "req_01J...",
  "recipe": { /* the full canonical Recipe, as documented in Part 1 */ }
}
```

Unlike `POST /api/import`, this returns the **complete** canonical Recipe —
the client needs every field to render the review screen.

Failure statuses match Part 1's extraction rows: 400 `Invalid recipe URL`, 400
`Unsupported platform`, 422 `Recipe could not be extracted`, 500.

**Open question — see "Interface ambiguities".** Whether the response carries a
server-issued recipe identity is unresolved and depends on whether any
persistence is introduced.

## B. `POST /api/exports/anylist` — export

Takes a canonical Recipe, which may have been edited by the user, and writes it
to AnyList.

```
POST /api/exports/anylist
Authorization: Bearer <token>
Idempotency-Key: <client-generated>        (recommended)
Content-Type: application/json

{ "schemaVersion": 1, "recipe": { /* full canonical Recipe */ } }
```

**200** — after read-back verification, as today. Note the id is
**client-generated** by the AnyList library, so `createRecipe()` returning it is
*not* persistence proof; `getRecipeById()` is (RESEARCH-PROVEN, ADR-021):

```json
{
  "success": true,
  "schemaVersion": 1,
  "requestId": "req_01J...",
  "saved": { "id": "<anylist-recipe-id>", "name": "..." },
  "idempotent": false
}
```

The export path **validates the submitted recipe independently**. Extraction
`warnings` carried on the recipe are informational history and are **never** a
reason to reject an export.

`idempotent: true` indicates a replay: no new AnyList write occurred and the
result is the one from the original request.

| Condition | Status | `error` |
|---|---|---|
| Recipe fails canonical validation | 400 | `Invalid recipe` |
| AnyList rejected or could not verify | 500 | `Recipe export failed` |
| `Idempotency-Key` reused with a different body | 409 | `Idempotency key conflict` |

This makes the canonical Recipe an **inbound** contract for the first time.
Today it is only ever a server output. Consequences are listed under
"Interface ambiguities".

## Schema versioning

Every production request and successful response carries `schemaVersion: 1`.

- **Inbound validation is strict.** Unknown keys are rejected, not ignored.
- A missing or non-integer `schemaVersion` is `400 Invalid request body`.
- A recognised-but-unsupported version is `400 Unsupported schema version`.

This exists because the canonical Recipe becomes an *inbound* contract for the
first time (ADR-007). Version 1 is the shape documented in Part 1.

### Additive optional fields do not bump the version

`ingredients[].alternateMeasurements` is version 1. Absence is accepted and
normalised to `null`; explicit `null` is accepted; an array is validated
strictly. Absence is the **only** leniency in the otherwise-strict inbound
schema.

**Rollout order: backend first, iOS later.** The backend must ship before any
client sends the field, so every request in that window comes from a client
whose ingredients have no such key — and strict validation would reject all of
them. Requiring `schemaVersion 2` here would have been worse than useless: it
would force every existing client to change in order to keep doing exactly what
it already does. Version 2 is for a change an old client would get *wrong*, and
a field it neither sends nor reads is not one.

## Idempotency-Key — IMPLEMENTED

**Required** on `POST /api/exports/anylist`. **Not required** on
`POST /api/imports`, which is read/compute-only and performs no external write.

- Length **1–128 characters**. Missing, empty, over-length, or otherwise
  invalid: `400 Invalid idempotency key`.

### Storage

**Upstash Redis via the Vercel Marketplace**, behind an `IdempotencyStore`
abstraction so the backing store can be replaced without touching route logic.

This is **request-coordination infrastructure only**. It is not a general
application database and does not reopen the no-database scope decision
(ADR-017). The store must support **atomic state transitions** — specifically
`NEW → IN_PROGRESS` and `FAILED_SAFE → IN_PROGRESS` must be atomic claims, or
two concurrent same-key requests can both believe they won.

### Retention is state-dependent (QA-021)

A single flat 24-hour TTL is **unsafe** and was corrected. If an `IN_PROGRESS`
or `AMBIGUOUS` record simply expired, the same `Idempotency-Key` would become
`NEW` again and could perform a second AnyList write **solely because time
passed** — which directly contradicts "a stale `IN_PROGRESS` is not evidence of
safety". Expiry is not evidence.

| State | Record retention | Behaviour |
|---|---|---|
| `COMPLETED` | 24 hours (replay window) | Replay the recorded result. After the window, ordinary key reuse may eventually be permitted per implementation policy. |
| `FAILED_SAFE` | 24 hours | Retry permitted, via the atomic `FAILED_SAFE → IN_PROGRESS` transition. |
| `IN_PROGRESS` | **Not a plain 24-hour TTL.** May carry a 30-day record TTL. | Persist long enough to defeat delayed retries. Staleness is decided by an explicit lease, never by record expiry. Age alone must **never** return it to `NEW`. |
| `AMBIGUOUS` | **30 days** (V1) | `409 Export outcome unknown` for the whole period. Never execute `createRecipe` again merely because the ordinary replay window elapsed. |

### Record TTL and execution lease are two different things

This distinction is the mechanism that makes the table above work, and it must
not be collapsed:

- **Record TTL** — how long the idempotency record exists in Upstash. Record
  preservation only.
- **`leaseExpiresAt`** — an explicit timestamp stored *on* the record, saying how
  long active execution is still expected.

Rules:

- A **stale execution lease does not delete the record.**
- When the lease is stale, the record transitions **atomically** to `AMBIGUOUS`.
- The store must atomically convert or interpret a stale `IN_PROGRESS` as
  `AMBIGUOUS` **before any new claim can be made** against that key. A reader
  must never observe stale `IN_PROGRESS` and treat it as claimable.

An `IN_PROGRESS` record may therefore hold a 30-day TTL alongside a much shorter
`leaseExpiresAt`. The long TTL preserves the uncertainty; the short lease says
nobody is still working on it.

### Frozen states

| State | Meaning | Behaviour on a same-key request |
|---|---|---|
| `NEW` | Key unseen. | Atomically claim → `IN_PROGRESS`, then proceed. |
| `IN_PROGRESS` | Claimed; export running or interrupted. | `409 Export already in progress`. Never call `createRecipe` again. |
| `COMPLETED` | Export succeeded and was verified. | Replay the recorded result. No second AnyList write. |
| `FAILED_SAFE` | Failed with positive evidence that **no** AnyList write occurred. | Atomically re-claim → `IN_PROGRESS`, then retry. |
| `AMBIGUOUS` | `createRecipe` may have been reached; outcome unknown. | `409 Export outcome unknown`. Never auto-retry. |

### Rules

- Same key + same validated request + `COMPLETED` → return the recorded result
  without another AnyList write.
- Same key + **different** request → `409 Idempotency key conflict`.
- Concurrent same-key request while `IN_PROGRESS` → `409 Export already in
  progress`.
- `AMBIGUOUS` → `409 Export outcome unknown`.
- **A stale `IN_PROGRESS` record must not automatically become retryable.**
  Absent positive evidence that `createRecipe` was never reached, a stale
  `IN_PROGRESS` is treated as `AMBIGUOUS`. Expiry is not evidence of safety.

### Not exactly-once

**This does not provide exactly-once semantics against AnyList and must never be
described as if it does.** AnyList exposes no native idempotency key, so we
cannot ask it to deduplicate. What this buys: our own retries and client replays
will not produce a second write, and an ambiguous outcome is never blindly
repeated. What it cannot prevent: a write that landed while we lost the answer.

RESEARCH-PROVEN and compounding this: `deleteRecipe()` returns success without
deleting, so a duplicate we create **cannot be cleaned up programmatically**
(ADR-021). That is precisely why the `AMBIGUOUS` path refuses to retry.

**And after 30 days, protection ends.** Once an `AMBIGUOUS` record is gone, the
same key is reusable and a second write becomes possible again. Thirty days is a
pragmatic bound on how long we hold uncertainty, not a proof of anything.
**Do not claim indefinite duplicate prevention.** True exactly-once protection
remains impossible while AnyList exposes no native idempotency key — the
retention policy narrows the window, it does not close it.

## Request fingerprint — IMPLEMENTED

"Same request" is decided by fingerprint, never by raw HTTP bytes.

1. **Validate** the export request first.
2. **Normalise** to the accepted canonical shape.
3. **Deterministically serialise** that normalised value.
4. **SHA-256** it.
5. **Store** the fingerprint on the idempotency record.

Equivalent JSON with different key ordering, or differing insignificant
whitespace, must **not** produce `409 Idempotency key conflict`. Comparing raw
bytes would make a conflict out of a re-serialisation, which is a false alarm
the client cannot fix.

### Empty `alternateMeasurements` is fingerprint-neutral

Step 2 normalises the accepted recipe, so a key that carries no information
would still change the hash simply by existing. Absent, `null`, and `[]` all
mean "this creator offered no alternate", so all three are normalised to an
**omitted key** before serialisation — byte-identical to how a pre-B4-B recipe
hashed.

Without this, adding the field would have re-hashed every alternate-free recipe
at the moment of deployment: a pre-deploy export that timed out and retried
afterwards would have been answered `409 Idempotency key conflict` for an
unchanged recipe, and every stored `IN_PROGRESS` and `AMBIGUOUS` record would
have become invisible to the retry it exists to stop — turning the safe answer
into a duplicate write.

A recipe carrying **real** alternates does hash differently. It is a different
recipe.

This is why no key-namespace bump, no `v2` route, and no `schemaVersion 2` were
needed: existing `idem:v1` records are genuinely still addressable, not versioned
around. Pinned against hashes captured from the pre-B4-B build in
`src/http/recipe-fingerprint.test.ts` and
`tests/production/exports-anylist-endpoint.test.ts`.

## Request IDs — IMPLEMENTED

**Every** response carries a request ID — `200`, `400`, `401`, `404`, `409`,
`413`, `415`, `422`, and `500` alike, with no exceptions.

- `X-Request-Id` response header, always.
- `requestId` in the JSON envelope wherever an envelope is returned.
- A client-supplied `X-Request-Id` is adopted rather than replaced, so a
  Shortcut or iOS client can correlate its own traces.

### Replay identifiers

On an idempotent replay, two identifiers are in play and they mean different
things:

| Field | Meaning |
|---|---|
| `requestId` | The **current** HTTP request — the one being answered now. |
| `originalRequestId` | The request associated with the **original** completed AnyList write and its recorded result. |

`originalRequestId` is included **only when relevant** — that is, on a replay of
a `COMPLETED` record. It is absent on a first execution.

Without both, a replay is indistinguishable from a fresh success in logs, which
makes duplicate investigation guesswork.

**Implemented.** Every response carries `X-Request-Id`, and `originalRequestId`
appears on replays. This was a Milestone 3 gap and is now closed.

## Error envelope

Unchanged in shape from Part 1, plus `requestId`:

```json
{ "success": false, "error": "<fixed string>", "requestId": "req_01J..." }
```

The redaction rule is unchanged and non-negotiable: `error` is a fixed string
selected by failure kind. Underlying messages, stacks, provider errors,
credentials, tokens, and request internals are never returned. Classification is
by error **code**, never by matching message text.

## HTTP error contract — IMPLEMENTED

Envelope is unchanged in shape; `requestId` is always present.

```json
{ "success": false, "error": "<fixed string>", "requestId": "req_..." }
```

| Condition | Status | `error` |
|---|---|---|
| Bad/absent bearer token | 401 | `Unauthorized` |
| Malformed body, bad URL, unknown keys, bad `schemaVersion` | 400 | `Invalid request body` |
| Unsupported `schemaVersion` value | 400 | `Unsupported schema version` |
| Missing/over-length/invalid `Idempotency-Key` | 400 | `Invalid idempotency key` |
| URL unparseable or non-http(s) | 400 | `Invalid recipe URL` |
| Host not TikTok/Instagram/YouTube-with-adapter | 400 | `Unsupported platform` |
| Submitted recipe fails canonical validation | 400 | `Invalid recipe` |
| Same key, different request | 409 | `Idempotency key conflict` |
| Same key, currently `IN_PROGRESS` | 409 | `Export already in progress` |
| Same key, `AMBIGUOUS` | 409 | `Export outcome unknown` |
| Request body exceeds the route limit | 413 | `Request body too large` |
| Content type is not `application/json` | 415 | `Unsupported content type` |
| Extraction produced nothing usable | 422 | `Recipe could not be extracted` |
| AnyList failure or anything unexpected | 500 | `Recipe import failed` / `Recipe export failed` |
| Unknown route | 404 | `Not found` |

**CURRENT gap:** 413 and 415 are not produced today — an oversized body returns
500 and a wrong content type returns 400. Verified against the running server.

### Body limits — IMPLEMENTED

| Route | Limit |
|---|---|
| `POST /api/import` (existing one-shot) | 8 KB |
| `POST /api/imports` | 8 KB |
| `POST /api/exports/anylist` | 64 KB |

Exports carry a full canonical Recipe, hence the larger allowance.

## Minimum usable recipe — IMPLEMENTED

`POST /api/imports` succeeds only when the extracted recipe has **all** of:

- a **non-blank title**
- **at least one ingredient**
- **at least one instruction**

Otherwise it returns the existing safe extraction-failure result
(`422 Recipe could not be extracted`).

This is **deterministic and structural**. It is explicitly **not** a confidence
threshold: QA established that current `confidence` does not correlate reliably
enough with whether edits are required to gate acceptance on it (ADR-019).

`confidence` and `warnings` remain extraction-time assessment (ADR-010). They do
not participate in this decision, and a recipe carrying warnings is a normal,
successful, exportable recipe.

### Where the rule lives (QA-003)

Implement the check at the **shared application / import-service boundary**
wherever practical, not inside the `/api/imports` route handler.

Otherwise the legacy `POST /api/import` convenience path keeps writing obviously
empty recipes into AnyList simply because it predates `/api/imports` — the same
extraction, held to a weaker standard, on the path that actually writes.
`importRecipe()` already exists as that shared boundary.

`POST /api/import` is **not removed**. It keeps its role for CLI and internal
use; it just stops being exempt from the minimum.

## Canonical input hardening — IMPLEMENTED

Applies to **untrusted inbound API data**. That is the security boundary; it is
deliberately not a mandate to make every internal Zod object strict, which would
cause churn for no safety gain.

**A. Semantic non-blank text (QA-023).** `min(1)` admits `"   "`, which is not
meaningful text. At the consumer API boundary, values are trimmed and required to
be non-blank:

| Field | Rule |
|---|---|
| `title` | trimmed, non-blank |
| `ingredients[].name` | trimmed, non-blank |
| `ingredients[].rawText` | trimmed, non-blank where the canonical schema requires it |
| `instructions[]` entries | trimmed, non-blank |
| `quantity`, `unit`, `preparation` | **nullable model preserved.** `null` stays a valid, meaningful "not stated". But a non-null whitespace-only value is not accepted as meaningful text. |

The canonical recipe **structure is not redesigned**: nullable stays nullable,
no fields are added or removed. This is validation strictness at the untrusted
boundary, nothing more.

**B. `source.url`.** Inbound consumer-API recipes accept **only** `http:` and
`https:` schemes.

**C. `TimeRange`.** Inbound accepts `{ minMinutes: n, maxMinutes: n }`, but
rejects `maxMinutes < minMinutes`. The **preferred producer form** for an exact
time remains `{ minMinutes: n, maxMinutes: null }`; our own extraction continues
to emit that form.

> **Contradiction flagged — see the report.** Accepting `maxMinutes === minMinutes`
> means `buildNote()` in `src/anylist/mapping.ts` will render `"40–40 minutes"`,
> because it treats any non-null `maxMinutes` as a range. Milestone 1.1 froze
> "an exact time is never encoded as `min === max`" on the producer side; this
> amendment makes that shape legal on the consumer side. A source fix is needed
> in Wave 1. No source was changed here.

**D. Unknown fields.** Consumer-facing API request bodies are **strict** —
unknown keys are rejected, not ignored.

## Canonical platform values

The canonical contract value set is:

```
"tiktok" | "instagram" | "youtube"
```

| Platform | Canonical support | Ingestion |
|---|---|---|
| TikTok | yes | implemented |
| Instagram | yes | implemented, with current metadata limitations |
| YouTube | yes | **not yet implemented** |

**The code enum is still `["instagram", "tiktok"]`.** The exact source change to
align it is proposed below and has not been applied. A YouTube URL is rejected
at platform detection today.

## Source provenance fields

`source.url`, `source.platform`, and `source.creator` are **read-only
provenance**. The iOS Review UI must not offer normal editing of them.

**This is a contract and UI invariant, not a server-verifiable security
property.** The server accepts a client-supplied canonical Recipe and has no way
to prove the provenance fields were not altered. For V1 we deliberately do
**not** introduce import persistence, signed receipts, or any cryptographic
enforcement solely to constrain a trusted first-party client. Stating the
limitation plainly is the point: anyone reading this contract should know the
invariant rests on client cooperation.

## Authentication scope

`RECIPE_API_KEY` is a **single static bearer token for deployment and prototype
use only.** It is acceptable for the current Vercel proof and for CLI use.

It **must not** become a universal secret embedded in a production App Store
binary. A shared secret shipped in a client binary is extractable by anyone who
downloads the app, and it identifies no one.

Consumer authentication is **decided as of 2026-08-24 and not yet built.** V1
uses anonymous, installation-scoped, server-minted opaque bearer credentials —
see **Part 3**, and ADR-026. Until that is implemented, `RECIPE_API_KEY` remains
the only credential the server accepts, and the constraint above is unchanged:
it must not ship in a distributed binary.

## Telemetry

Structured, one event per request, no free-text interpolation of user or
provider data.

| Field | Example | Notes |
|---|---|---|
| `requestId` | `req_01J...` | correlates with the response |
| `route` | `/api/imports` | |
| `platform` | `tiktok` | absent when detection failed |
| `outcome` | `success` \| `failure` | |
| `failureKind` | `extraction_failed` | absent on success |
| `status` | `422` | |
| `elapsedMs` | `14320` | |
| `extractionMs`, `exportMs` | `12100`, `2100` | per-phase |
| `confidence` | `0.9` | extraction only |
| `warningCount` | `2` | count, not contents |
| `idempotent` | `false` | export only |

Never logged: the `Authorization` header, `RECIPE_API_KEY`, AnyList credentials,
the Anthropic key, full third-party error objects, or full recipe contents.
Recipe **title** on success is acceptable and already logged today.

`inputTokens` / `outputTokens` **may remain `null` initially**, because
`parseRecipe()` does not expose Anthropic usage. Parser contracts are **not**
being changed solely for telemetry during this amendment.

**Structured logs are acceptable as the initial telemetry store.** No metrics
backend is required for V1.

`elapsedMs` and the phase split are the inputs to the deployment timeout
decision. They are **no longer** described as inputs to a confidence gate — see
ADR-019.

## AnyList error classification — IMPLEMENTED

`AnyListError` gains a `code`:

```ts
code: "login_failed" | "create_failed" | "verify_unreadable" | "verify_missing"
```

**The AnyList layer reports facts only.** It states what happened; it does not
decide what that means for retry safety. Interpretation belongs to the
application layer:

| AnyList code | Application state | Why |
|---|---|---|
| `login_failed` | `FAILED_SAFE` | Authentication failed, so the write was never attempted. Positive evidence of no write. |
| `create_failed` | `AMBIGUOUS` | The call was made. A thrown exception does not prove the write did not land. |
| `verify_unreadable` | `AMBIGUOUS` | The write may have succeeded and only the read-back failed. |
| `verify_missing` | `AMBIGUOUS` | Read-back found nothing, but eventual consistency cannot be ruled out. |

**A `createRecipe` exception must not be classified as safely retryable** unless
future evidence proves no write could have occurred. Only `login_failed`
currently carries that evidence.

This is stricter than it may look: three of the four codes are non-retryable.
That is deliberate, and it follows directly from `deleteRecipe()` being
unreliable — an unnecessary duplicate cannot be cleaned up (ADR-020, ADR-021).

### Missing AnyList configuration uses `login_failed`

Missing or empty `ANYLIST_EMAIL` / `ANYLIST_PASSWORD` reports `login_failed` for
V1. This is a deliberate simplification, and it is worth naming what it costs:
it **collapses deployment misconfiguration and genuine credential failure into
the same `FAILED_SAFE` class**.

That is safe — neither reached AnyList, so neither could have written — but it is
lossy for diagnosis. An operator seeing `login_failed` cannot tell "the secret
is missing from this environment" from "the password is wrong".

A `config_missing` discriminator may be added later if the consumer or
operations layer needs to distinguish them. Not required for V1.

## APPLIED — YouTube in the canonical enum, and the Platform boundary

**Status: applied on 2026-08-21.** Recorded here because it changed a
cross-boundary contract (ADR-008). No YouTube ingestion was added.

### What changed

1. **`src/recipe/schema.ts`** — the canonical enum is now
   `z.enum(["tiktok", "instagram", "youtube"])`.

2. **`src/social/types.ts`** — the social layer no longer restates its own
   platform union. It derives from the canonical one:

   ```ts
   import type { Platform as CanonicalPlatform } from "../recipe/schema.js";

   export type Platform = Extract<CanonicalPlatform, "instagram" | "tiktok">;
   ```

3. **`src/social/index.ts`** — `ADAPTERS` is `Record<Platform, SocialAdapter>`,
   exhaustive by construction against the derived subset.

4. **Tests** — the invalid-platform fixture moved from `"youtube"` to
   `"pinterest"`; new tests assert the canonical schema accepts `"youtube"`
   while ingestion still rejects YouTube URLs with `unsupported_platform`.

### Correction to an earlier claim in this document

An earlier revision of this section proposed
`Record<Exclude<Platform, "youtube">, SocialAdapter>` and stated that it would
keep the gap enforced by the type system. **That was wrong.** At the time,
`src/social/types.ts` declared its own hand-written
`Platform = "instagram" | "tiktok"`, so `Exclude<..., "youtube">` resolved to an
unchanged union and enforced nothing.

The relationship is **not** enforced by the adapter map typing. It is enforced
by the `Extract<CanonicalPlatform, ...>` derivation in `src/social/types.ts`.
The adapter map merely has to be exhaustive over whatever that derivation
yields. With the derivation in place, the `Exclude<>` became redundant and was
removed.

Verified: renaming a canonical platform value now produces compile errors,
including the social `Platform` collapsing to the surviving subset.

### Ownership rule

- The **canonical Recipe owns the full platform vocabulary**
  (`src/recipe/schema.ts`).
- **Social ingestion declares only the subset it implements**, by derivation,
  never by restatement.
- The import is **type-only**, so no runtime dependency is introduced from the
  social layer to the recipe layer.
- Adding a canonical platform without an adapter is safe and silent. Renaming or
  removing one is a compile error. Neither can drift.

### Current platform status after this change

| Platform | Canonical enum | Ingestion adapter | A URL today |
|---|---|---|---|
| TikTok | yes | yes | extracted |
| Instagram | yes | yes | extracted, metadata limits apply |
| YouTube | **yes** | **no** | `400 Unsupported platform` |

HTTP behaviour is unchanged by this work. No `501` was added; whether an
unimplemented-but-canonical platform deserves a distinct status remains an
unproposed contract change.

---

# Part 3 — APPROVED, NOT IMPLEMENTED (consumer authentication)

**Status: approved 2026-08-24, and no part of it exists in code.** No
registration route is mounted, no consumer credential can be minted, and
`RECIPE_API_KEY` remains the only credential the server accepts. Everything
below describes what M5E-B will build. Do not build against it as though it
were live, and do not read the presence of this section as a deployment.

The public registration route in particular **must not be exposed** before the
rate limits and quotas in this section exist (M5E-B3). An unlimited public
endpoint that mints credentials to anyone is a cost liability, not a feature.

## Why this exists

`RECIPE_API_KEY` cannot ship in an App Store binary (ADR-014). A shared secret
in a distributed client is extractable by anyone who downloads the app, cannot
be revoked for one user, and identifies nobody. Every screen of the iOS client
now depends on a credential, so the alternative had to be decided before broad
distribution.

The decision is **anonymous, installation-scoped, server-minted opaque bearer
credentials** (ADR-026). No account, no email, no password, no Apple ID.

## Two credential types

| Credential | Who holds it | Purpose |
|---|---|---|
| `RECIPE_API_KEY` | the operator | CLI, smoke tests, private tooling |
| `sr1_…` installation token | one app installation | consumer traffic |

Both arrive in the same `Authorization: Bearer` header. Both continue to work.
The static key is **not** deprecated by this section — it stops being the thing
a consumer build carries, which is a different statement.

## `POST /api/client/register` — public

The only route besides `GET /health` that requires no credential. It must not
require `RECIPE_API_KEY`: an App Store client has no way to hold one.

```
POST /api/client/register
Content-Type: application/json

{ "schemaVersion": 1 }
```

The body carries **nothing else**. No `installationId`, no device name, no
hardware identifier, no Apple ID, no attestation, and no client-supplied
secret. Strict validation applies as everywhere else: unknown keys are
rejected.

**200**

```json
{
  "success": true,
  "schemaVersion": 1,
  "requestId": "req_01J...",
  "client": {
    "id": "<clientId>",
    "token": "sr1_<clientId>_<secret>"
  }
}
```

`client.id` is public and safe to log. `client.token` is a secret, is returned
**only** at issuance, is never recoverable afterwards, and must never be
logged — see "Logging" below.

| Condition | Status | `error` |
|---|---|---|
| Malformed body, unknown keys, bad `schemaVersion` | 400 | `Invalid request body` |
| Unsupported `schemaVersion` value | 400 | `Unsupported schema version` |
| Registration rate limit exceeded | 429 | `Too many requests` |
| Credential store unavailable, or anything unexpected | 500 | `Registration failed` |

## Token format

```
sr1_<clientId>_<secret>
```

- `sr1_` — product and format version. A future format is `sr2_`, and a secret
  scanner can be given one rule that matches every token we will ever issue.
- `clientId` — 16 random bytes, base64url. **Public.** It is the store lookup
  key, the operational log identifier, and the principal that quotas and
  revocation are keyed on.
- `secret` — 32 random bytes (256 bits), base64url, from a CSPRNG.

Opaque, not a JWT. There is no third party verifying these offline, no claims
to carry, and no expiry the server cannot enforce directly — a signed token
would add key management in exchange for nothing. The id/secret split is what
makes verification a single keyed lookup rather than a scan, and what gives us
a non-secret identifier to put in logs.

## Client record

```
client:v1:<clientId>          (Redis hash)

  secretHash    SHA-256 hex of the secret component
  status        "active" | "revoked"
  createdAt     epoch ms
  lastSeenAt    epoch ms — absent until the credential first authenticates
  revokedAt     epoch ms — present only when revoked
```

**The raw secret is never stored.** Only its digest is, and verification is a
constant-time comparison of digests, the same construction `isAuthorized`
already uses for `RECIPE_API_KEY`. SHA-256 is the right primitive here and a
password KDF would be the wrong one: this is a 256-bit random secret with no
dictionary to resist, and a deliberately slow hash would tax every
authenticated request.

No `tokenVersion` field. It was considered and dropped: rotation is deferred
(ADR-026), so nothing would read it, and a field with no reader is a field that
drifts.

This is **authentication infrastructure, not application data**. It stores no
recipe, no caption, no user content, and it does not reopen the no-database
scope decision any more than the idempotency records did (ADR-017). Anyone
proposing to keep recipes here is proposing a scope change.

## Credential lifetime

**Long-lived until revoked.** No periodic expiry, no scheduled rotation, no
refresh flow in V1.

That is defensible because the credential is stored in the iOS Keychain rather
than in application storage, authorises only recipe extraction and an export to
the operator's own AnyList account, is revocable server-side at any time, and
has a silent recovery path: a client that finds itself unauthenticated simply
registers again. There is no account to lock anyone out of, so forced expiry
would buy no safety and would add a renewal path that can fail.

### Orphan cleanup

A credential that has **never successfully authenticated a protected request**
and is more than **7 days old** is eligible for cleanup. The observable is
`lastSeenAt`: absent means the credential was minted and never used.

The first successful authentication makes the record durable. From that point
it survives until revoked or replaced.

Note the contrast with idempotency retention (ADR-025), where expiry was
explicitly forbidden as a signal. The reasoning does not transfer, and it is
worth saying why rather than leaving it to look like an inconsistency. There,
a record vanishing would let a second AnyList write happen solely because time
passed, and the resulting duplicate could not be cleaned up. Here, a record
vanishing costs an unused credential its existence; the only client that could
ever have presented it re-registers and continues. Nothing external happened,
and nothing is unrecoverable.

## Registration retry, and the orphan tradeoff

Because the request carries no installation identity, the server cannot
recognise a retry. A response lost in transit therefore means the client
retries and receives a **second** credential, and the first becomes an orphan.

This is accepted deliberately. The alternatives are worse:

- Returning the same token for a repeated registration would require storing
  the raw secret in recoverable form, which defeats hashing it.
- Keying issuance on a client-supplied `installationId` would make that
  identifier a de facto secret. It is transmitted, not proven, so anyone who
  learned one could force a reissue and knock that installation offline —
  while the whole point of the identifier is that it need not be secret.

An orphan is a credential nobody holds, so it can never authenticate anything.
Orphan cleanup bounds how long it exists, and the registration rate limits
bound how many can accumulate.

## Authenticated principal

Credential verification resolves to a principal, attached to the request:

```
internal      — the operator's RECIPE_API_KEY
installation  — a consumer credential, carrying its public clientId
```

Route handlers do not parse credentials and do not know which type authorised
the request. The principal is the seam that rate limits, quotas, revocation,
and any future attachment of an installation to a signed-in user will hang
from. No subscription tiers, no roles, no scopes in V1.

## Resolution order on protected routes

1. Parse the `Bearer` header. No header, or no `Bearer ` prefix → 401.
2. Constant-time compare against `RECIPE_API_KEY`. A match resolves to the
   **internal** principal and performs **no store lookup** — CLI and smoke
   traffic pay none of the consumer path's latency.
3. Otherwise, parse the `sr1_` format. A token that is not well formed → 401,
   again without a store lookup.
4. Read `client:v1:<clientId>`. Absent → 401.
5. Require `status: "active"` and a constant-time match on the secret digest.
6. Attach the **installation** principal, and record `lastSeenAt`.
7. Anything else → the existing 401 behaviour, unchanged.

`lastSeenAt` is written on the **first** successful authentication — which is
what makes the record durable — and thereafter only when the stored value is
more than a day stale. Writing it on every request would double the store cost
of the hot path to keep a timestamp accurate to the second that nothing reads
that precisely.

Consumer authentication therefore depends on Redis being reachable. That is
accepted: an unreachable store fails closed, and immediate revocation was
preferred over a validation cache that would keep a revoked credential working
for the length of its TTL.

### An unreachable store is a 500, not a 401

Two absences that look similar and are not:

| Situation | Answer |
|---|---|
| No credential store configured — this deployment does not offer consumer auth | `401 Unauthorized` |
| A configured store cannot answer | `500`, through the route's existing failure string |

A 401 is a statement about the credential. An outage is a statement about us,
and answering it with 401 would be actively harmful rather than merely
imprecise: the client behaviour below treats 401 as *discard this credential
and register again*, so a store blip answered with 401 would make every
consumer app destroy a working credential and hit the registration endpoint in
the same moment — losing the credentials and stampeding the mint at once.

Neither answer reveals anything about the store. The 500 carries the route's
ordinary failure string, so a caller learns that the request failed and nothing
about why.

## Revocation

The server can mark a record `revoked`. A revoked token authenticates as
invalid and its requests answer 401 like any other rejected credential — the
distinction is operational, not client-facing. The record is kept rather than
deleted so that revocation is an observable fact rather than an absence.

No admin endpoint is part of M5E-B. Revocation is a store-level operation.

## Rate limits and quotas

Configurable server-side, not constants buried in route logic. The values below
are the approved starting points, not contract guarantees.

| Limit | Scope | Value |
|---|---|---|
| Registration | per IP | 5/hour, 20/day |
| Registration | global | 20/minute (configurable circuit breaker) |
| `POST /api/imports` | per client | 20/day |
| `POST /api/exports/anylist` | per client | 40/day |

Quotas apply to the **installation** principal. Internal `RECIPE_API_KEY`
traffic does not inherit them; if it should ever be limited, that is a separate
decision rather than a side effect of this one.

The import quota is the one that matters financially: extraction is the only
operation that spends money with a third party on an anonymous caller's
behalf.

The global ceiling is set at **20 a minute**, which is roughly sixty times what
a single address may register in a whole day — far above any legitimate burst,
and low enough that a distributed attempt is capped rather than open. It is
deliberately conservative for a product with no users yet, and should be raised
against measured demand rather than pre-emptively.

**A quota counts requests served, not writes performed.** An idempotent export
replay consumes a unit like any other request: it is answered, so it is
counted. That keeps the accounting predictable and stops repeated replays being
a free channel, at the cost of one logical export costing two units if a client
retries a completed one. Idempotency still governs how many AnyList recipes
exist; the quota governs how many requests we serve.

### `429 Too many requests`

New API vocabulary, approved 2026-08-24 (ADR-027). The envelope is unchanged:

```json
{ "success": false, "error": "Too many requests", "requestId": "req_..." }
```

**One string, deliberately.** Registration limits and per-client quotas are hit
in completely different circumstances — onboarding versus daily use — so the
client already knows which one it met from what it was doing. A second string
would let a client branch on a distinction it cannot act on differently.

### Proxy trust

Per-IP limiting is meaningless on Vercel until the server is configured to read
the forwarded client address. Without it, every request appears to originate
from the platform's proxy and the per-IP bucket becomes one global bucket.

Trust must be scoped to the platform hop. Trusting arbitrary
`X-Forwarded-For` values would let any caller choose their own rate-limit
bucket, which is worse than not limiting at all, because it would look like it
worked.

**As implemented (M5E-B3):** the address is resolved explicitly rather than
through Fastify's `trustProxy`, which would require asserting a hop count that
cannot be verified from a development machine. The rule prefers
`x-vercel-forwarded-for`, else takes the **rightmost** entry of
`x-forwarded-for` — rightmost because the header grows left to right as each
proxy appends, so the leftmost entry is whatever the caller claimed and the
rightmost is what the last proxy observed. A caller's invented entries sit to
the left of the platform's and change nothing.

**This assumption is unverified against a deployed environment.** It holds if
the platform appends to or replaces the header, and fails only for a proxy that
forwards a client's header untouched — which no header-based rule survives.
**M5E-B4 must confirm it against a real deployment** before the per-IP limit is
treated as real. The global ceiling is deliberately independent of it, so a
wrong answer here degrades attribution rather than removing the limit.

## Client recovery behaviour

Normative for the iOS client (M5E-C), stated here because it is the client half
of the 401 contract:

```
launch → read the credential from the Keychain
       → absent? register once, store it, continue
401 on a protected route
       → discard the stored credential
       → register once
       → retry the original request once
       → a second 401 stops, and surfaces an authentication failure
```

The cap of one re-registration per session is what prevents a misconfigured or
failing server from turning every client into a registration loop. The client
cannot distinguish a revoked credential from a server misconfiguration on the
wire, and does not need to: one attempt resolves the first case and fails
safely in the second.

## Logging

Consumer bearer tokens are secrets and are subject to the same non-negotiable
rule as every other credential in this document. They must never appear in
request logs, response logs, telemetry, exception metadata, analytics, or
debug output.

The existing structural Pino redaction of `req.headers.authorization` already
covers an installation token arriving on a request. What is new is a token in a
**response**: the registration route is the only place a raw secret is ever
produced, and that object must not reach a log line. The registration route
logs `clientId` and nothing else about the credential.

`clientId` is not a secret and is the intended operational identifier — in
telemetry, in log lines, and in support conversations.

## What this is not

Anonymous installation registration proves neither a human nor a genuine Apple
device. It establishes that a credential was minted and is being presented
consistently, and nothing more. Sybil registration is cheap by construction.

Abuse is bounded by registration IP limits, per-client quotas, the global
circuit breaker, revocation, and cost instrumentation — not by identity. App
Attest and DeviceCheck are **not** required for V1 (ADR-026) and are recorded
as future defence in depth if abuse demonstrates the need.

**Do not describe this as device attestation.** It is not, and a document other
people build against should not imply a guarantee it does not provide.

## Implementation verification plan

M5E-B is not complete until each of these is covered:

- token mint, parse, and hash — including that a malformed token is rejected
  before any store lookup
- the raw secret is never written to the store; only its digest is
- a valid installation token authenticates a protected route
- an unknown `clientId` → 401
- a correct `clientId` with a wrong secret → 401
- a revoked credential → 401
- `RECIPE_API_KEY` still authenticates every protected route
- `GET /health` remains public
- `POST /api/client/register` is public and works without any credential
- every other route remains protected, and an unmatched path still answers
  `404 Not found` rather than 401
- registration rate limits and per-client quotas enforce, and answer
  `429 Too many requests`
- quota keying is per IP for registration and per client for protected routes
- a lost registration response leaves the client able to recover, and the
  orphan is cleaned up
- log redaction covers an installation token on every failure path, asserted
  against real emitted output as the existing redaction suite does
- an unavailable credential store fails closed rather than open

The store gets a conformance suite run against both an in-memory and a Redis
implementation, mirroring `IdempotencyStore`. Note the standing caveat: the
Upstash half of that pattern is currently live-gated, so the same gap will
apply here unless it is addressed.

## Sequencing

| Milestone | Scope |
|---|---|
| M5E-B1 | token primitives, client store, tests |
| M5E-B2 | principal authentication, `RECIPE_API_KEY` coexistence, telemetry and redaction |
| M5E-B3 | public registration, proxy trust, rate limits, quotas |
| M5E-B4 | deploy, private live smoke verification |
| M5E-C | iOS Keychain registration, installation auth, bounded 401 recovery |

B1 and B2 build and test the whole mechanism before anything is publicly
reachable. The public endpoint is deliberately last.

**None of this unblocks broad consumer release on its own.** ADR-023 — native
`set-cookie` leakage to stderr on failed AnyList login — remains unresolved and
is a separate gate.
