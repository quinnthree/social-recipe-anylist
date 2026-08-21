# Contracts

This document has two parts.

- **Part 1 — CURRENT** describes the original proof endpoint and CLI.
- **Part 2 — IMPLEMENTED** describes the production API. As of Milestone 4 it is
  **built, tested, and merged** — it is no longer a proposal. What remains
  outstanding is **live deployment verification**, not implementation.
- **RESEARCH-PROVEN** marks measured findings from the AnyList and QA
  workstreams. These are observations about the world, not statements about our
  code. They appear inline where relevant and in full in `architecture.md`.

Every claim in this document is tagged with one of those three. If something is
untagged, treat it as CURRENT.

Last updated: 2026-08-21.

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

**Still outstanding: live deployment verification.** Nothing below has been
exercised against a deployed Vercel environment or a live Upstash instance. The
private Vercel smoke test is the next step. Implemented and tested is not the
same as verified in production — in particular, Redis conformance is live-gated
(see `handoff.md`) and the 28 skipped tests are exactly the ones that would
exercise external systems.

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

Consumer/user authentication is a **future contract decision** that must be made
before broad distribution. It is out of scope for Wave 1 and is not solved by
anything in this document.

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
