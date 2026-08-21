# Contracts

This document has two parts.

- **Part 1 — Current** describes what is implemented and running today.
- **Part 2 — Proposed** describes the production contracts under discussion.
  **Nothing in Part 2 is implemented.** Do not build against it until it is
  approved and moved into Part 1.

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

## Current limits

- **Synchronous.** A request runs source fetch + Claude call + AnyList
  save-and-verify. Tens of seconds is normal.
- **No idempotency.** A client retry after a timeout can create a duplicate
  recipe in AnyList.
- **No persistence.** No database, queue, job IDs, or server-side recipe identity.
- **No request IDs are returned.** Fastify assigns an internal `reqId` for logs
  only; it is not exposed in any response.

---

# Part 2 — PROPOSED (not implemented)

Everything below is a proposal. It is not built. It requires approval before any
agent implements against it.

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

**200** — after server-side verification, as today:

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

## Idempotency-Key

Client-generated opaque string, max 255 chars. Recommended on
`/api/exports/anylist`, optional on `/api/imports`.

### Frozen semantics

- **Retention:** 24 hours.
- **Same key + same request + completed:** replay the original completed
  response. No second AnyList write.
- **Same key + different request body:** `409 Idempotency key conflict`.
- **Concurrent requests with the same key:** at most one may execute the export.
- **A request already marked in progress must not execute `createRecipe`
  again.**
- **Ambiguous external-write failures must never automatically retry
  `createRecipe`.**

### Conceptual states

| State | Meaning | On a replay |
|---|---|---|
| `NEW` | Key unseen. | Proceed; claim the key first. |
| `IN_PROGRESS` | Claimed, export running or interrupted. | Do **not** call `createRecipe`. Return in-progress; never re-execute. |
| `COMPLETED` | Export succeeded and was verified. | Replay the stored response, `idempotent: true`. |
| `FAILED_SAFE` | Failed with confidence that **no** AnyList write occurred (validation rejected it, login failed, request never sent). | Safe to retry. |
| `AMBIGUOUS` | `createRecipe` was called and the outcome is unknown — timeout, connection reset, or a failed verification read after a possible write. | **Never auto-retry.** Surface for human or client decision. |

The `FAILED_SAFE` / `AMBIGUOUS` distinction is the important one. It is the
difference between "definitely nothing happened, try again" and "something may
already be in the user's AnyList account." Only the first is retryable.

### Honest limits

**This does not provide exactly-once semantics against AnyList, and must not be
described as if it does.** The AnyList API exposes no idempotency key of its
own, so we cannot ask it to deduplicate. What these semantics actually buy:

- Our own retries and client replays will not cause a second write.
- A write whose outcome we cannot determine is never blindly repeated.

What they cannot prevent: a genuine `AMBIGUOUS` case where the write landed but
we never learned it. That resolves by inspection, not by protocol.

### Storage

Idempotency requires **durable, shared** state. An in-process map is
**explicitly not acceptable** on Vercel: it is lost on restart and inconsistent
across instances, which is worse than no idempotency because it presents a false
guarantee.

**The storage implementation is deliberately not chosen in Wave 0.** The Backend
agent will compare the smallest appropriate Vercel-compatible durable stores and
propose one. The semantics above are frozen regardless of that choice.

## Request IDs

Every response, success or failure, carries `requestId`. Same value in the
`X-Request-Id` response header and in every log line for that request. If the
client sends `X-Request-Id`, it is adopted rather than generated, so a Shortcut
or iOS client can correlate its own traces.

Not implemented today: no request ID is currently exposed in any response.

## Error envelope

Unchanged in shape from Part 1, plus `requestId`:

```json
{ "success": false, "error": "<fixed string>", "requestId": "req_01J..." }
```

The redaction rule is unchanged and non-negotiable: `error` is a fixed string
selected by failure kind. Underlying messages, stacks, provider errors,
credentials, tokens, and request internals are never returned. Classification is
by error **code**, never by matching message text.

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

`elapsedMs` and the phase split are the inputs to the deployment timeout
decision and to the eventual confidence gate on expensive extraction.

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
