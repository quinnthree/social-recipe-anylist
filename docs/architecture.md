# Architecture

Status: describes the intended production shape. Where the current
implementation differs, that is stated explicitly.
Last updated: 2026-08-21.

## Pipeline

```
     inputs              ingestion            extraction          canonical            export
  ┌───────────┐      ┌──────────────┐     ┌──────────────┐   ┌─────────────┐   ┌──────────────┐
  │ TikTok    │      │ platform     │     │ source text  │   │             │   │ AnyList      │
  │ Instagram │ ───► │ detection +  │ ──► │ → structured │──►│   Recipe    │──►│ export       │
  │ YouTube   │      │ source fetch │     │ extraction   │   │             │   │ adapter      │
  └───────────┘      └──────────────┘     └──────────────┘   └─────────────┘   └──────────────┘
        │                    │                     │                │                  │
   share sheet         per-platform          text-first,       provider-        verified save:
   or pasted URL         adapter            Zod-validated       neutral         write then read
                                                                                    back
```

The two halves are separate concepts. **Ingestion + extraction** produce a
canonical Recipe. **Export** consumes one. In production they are separate API
operations with the Review/Edit step between them (see `contracts.md`).

## The canonical Recipe is the centre

The canonical Recipe is **provider-neutral**. It is not an AnyList object, it
does not carry AnyList fields, and it does not encode AnyList limitations.
Everything upstream produces it; everything downstream consumes it.

This is what keeps AnyList replaceable. AnyList is the primary — and in V1, the
only — destination, but it is an **export adapter**, not the model. Concretely:

- The canonical Recipe holds `prepTime`/`cookTime` as `{minMinutes, maxMinutes}`
  ranges. AnyList holds a single integer of minutes. The **adapter** flattens to
  the lower bound and preserves the full range in the AnyList note. That
  compromise lives in the adapter, not in the model.
- The canonical Recipe holds `rawText` per ingredient. AnyList has no field for
  it. The adapter drops it on the way out; the model keeps it.
- The canonical Recipe holds `confidence` and `warnings`. These are ours. They
  never go to AnyList.

If AnyList changes, or a second destination is added, only the adapter changes.

## Extraction is text-first

Current extraction reads **text only**:

- **TikTok** — the public oEmbed endpoint returns the caption and creator.
- **Instagram** — one unauthenticated request, reading Open Graph metadata.
  Best-effort; frequently blocked by a login wall, and it fails cleanly when it
  is.
- **YouTube** — canonical support yes, *ingestion not yet implemented.* See
  "Platform status" below.

That text goes to a single Claude call constrained by the canonical schema, and
the result is re-validated with Zod on our side. Nothing is inferred that the
source did not state; missing information stays missing and produces a warning.

`confidence` and `warnings` are computed **deterministically in our code** from
what was actually extracted. The model does not report its own confidence.

### Confidence and warnings are an extraction-time assessment

They describe **what the extraction engine originally produced**, at the moment
it produced it. They are a historical record, not a live quality score.

They are **not recomputed** after the user edits the recipe. A user who fixes a
missing serving count does not cause `warnings` to shrink; the original
assessment stands. This keeps the values meaningful as telemetry and as the
future gate for expensive extraction (ADR-009) — recomputing them after a human
correction would contaminate exactly the signal that gate depends on.

Two consequences that matter downstream:

- The **export path validates the edited recipe independently** and must never
  treat a stale extraction warning as an export failure. A recipe carrying
  warnings is a normal, exportable recipe.
- The **iOS review UI may mark warnings as resolved** in its own presentation
  layer once the user has addressed them. That is a display concern. The
  canonical values are unchanged.

## Platform status

| Platform | Canonical support | Ingestion | Notes |
|---|---|---|---|
| TikTok | yes | implemented | public oEmbed; caption + creator |
| Instagram | yes | implemented | Open Graph only; login wall is a designed failure |
| YouTube | yes | **not implemented** | valid in the contract; no adapter exists |

A YouTube URL submitted today is rejected at platform detection, because
`youtube.com` is not a recognised host. Canonical support means the *contract*
admits the value, not that ingestion works.

## Expensive extraction is deferred and gated

Audio transcription and video frame analysis are **not** in the current
pipeline and are not part of Wave 1. When they arrive, they are:

- **Later** — only after the text-first path is solid and measured.
- **Gated** — invoked only when the cheap path produces a result below a
  confidence or completeness threshold, never by default.

The gate is the reason `confidence` and `warnings` are computed deterministically
now: they are the signal that will eventually decide whether to escalate. This
is a design constraint on today's code, not a future concern.

## iOS and the Share Extension stay thin

Both are **transport and presentation only**. They:

- accept or receive a URL,
- call the API,
- render the returned canonical Recipe for review and edit,
- send the edited Recipe back for export,
- display the result.

They do **not** contain extraction logic, platform detection, recipe parsing,
normalisation, AnyList knowledge, or AnyList credentials. A rule that decides
what a recipe *is* belongs on the server, where it can be changed without an App
Store release.

The Share Extension is thinner still. It runs under tight memory limits and can
be killed mid-flight, so it does the minimum: capture the URL, hand off, get out.
It does not host the review UI.

## Research-proven findings (measured, 2026-08-21)

Recorded from the AnyList production research and QA workstreams. These are
**measured observations**, distinct from CURRENT implementation and from
PROPOSED contract.

### Session and token behaviour

- `fromTokens()` restores a usable authenticated client **without network
  validation**.
- Token-only restore was proven in a fresh process with `ANYLIST_EMAIL` and
  `ANYLIST_PASSWORD` **absent**.
- A restored session successfully performed `getRecipes`, `createRecipe`, and
  `getRecipeById`.
- Access token lifetime: **~3600 seconds**. Refresh token lifetime: **~730
  days**. The refresh token **did not rotate** during a forced-refresh flow.
- Multiple clients restored from the same token blob operated concurrently
  without interference.

**Consequence, stated carefully.** The backend password is not *technically*
required after an initial connection. But the stored refresh/session material is
itself a long-lived bearer credential with account-level authority — a ~730-day
key to the account. Moving from password storage to token storage **does not
materially eliminate credential risk**; it changes its shape. The current
`ANYLIST_EMAIL` / `ANYLIST_PASSWORD` model remains acceptable for the private
Vercel proof and is explicitly temporary. Connect/disconnect architecture is not
being built now.

### Deletion is unreliable

`deleteRecipe()` has been observed returning success **without removing the
recipe**. Multiple request shapes produced HTTP 200 with no deletion. Treat
programmatic AnyList deletion as unsupported for V1: no rollback, no Undo, no
compensating transaction. See ADR-021.

### Recipe identifiers are client-generated

**Correcting earlier documentation in this repository.** The AnyList recipe
identifier is generated by the client library/protocol, **not** proven to be
server-assigned. `createRecipe()` returning an id is therefore **not proof of
persistence**.

Post-save verification remains mandatory and is the only persistence evidence
we have:

```
createRecipe()  →  getRecipeById()  →  verify the recipe is really there
```

Idempotency is **not** being redesigned around caller-controlled recipe ids.

### prepTime / cookTime do persist

**Correcting earlier documentation.** Research successfully created a recipe
with `prepTime=15` and `cookTime=40` and read both back correctly. The earlier
claim that these always persist as `0` is **not supported**.

The note-based time preservation stays for now. It is
**conservative compatibility behaviour** — information-preserving, harmless, and
the only place a stated *range* survives at all, since AnyList holds a single
integer. It is no longer described as a workaround for a proven zero-persistence
bug. It is not removed during Milestone 4.

### Native stderr can leak, and redaction does not stop it

On failed login, the native Rust library writes diagnostic data **directly to
stderr**, before any JavaScript logging or redaction can intercept it. Observed
content includes HTTP response metadata **including `set-cookie` values**. On a
deployed host this lands in platform logs.

**Pino redaction must not be represented as complete protection against native
stderr output.** It governs what our JavaScript logs; it cannot govern what a
native library writes to a file descriptor.

Acceptable for private smoke testing with known-good credentials. Broad consumer
deployment requires investigation and mitigation first. The AnyList research
workstream must additionally test whether failed or restored-token flows produce
equivalent leakage. See ADR-023.

## Minimum usable recipe

Extraction succeeds only when it yields a non-blank title, at least one
ingredient, and at least one instruction. Deterministic and structural — not a
confidence threshold (ADR-019). Anything less returns the existing safe
extraction-failure result.

## Instagram public-endpoint hardening (required before public exposure)

Not implemented; not part of this documentation task. Belongs in the **Instagram
adapter**, not the HTTP layer:

- Do not blindly follow redirects. Validate **each** destination against the
  accepted Instagram host policy.
- Require HTTPS; resolve relative `Location` values safely; bound the redirect
  count; reject external redirects.
- Detect login walls and interstitials, and never pass arbitrary interstitial
  description text to the recipe model as though it were a creator caption.

## Idempotency infrastructure

Export idempotency uses **Upstash Redis via the Vercel Marketplace**, behind an
`IdempotencyStore` abstraction. This is **request-coordination infrastructure
only** — it is not a general application database and does not reopen the
"no database" scope decision (ADR-017). Only `POST /api/exports/anylist`
requires it; `POST /api/imports` is read/compute-only.

## Known gaps between this document and the code

These are stated so the document does not read as a description of something
that exists.

1. **YouTube ingestion is not implemented.** The canonical enum now includes
   `"youtube"` (applied 2026-08-21), but only `instagram.com` and `tiktok.com`
   are recognised hosts and no YouTube adapter exists. A YouTube URL returns
   `400 Unsupported platform`. The social layer derives its narrower platform
   set from the canonical one (ADR-016), so this gap cannot drift.
2. **Extraction and export are not yet separate API operations.** The current
   `POST /api/import` does both in one call. The split is proposed in
   `contracts.md` and not implemented.
3. **There is no persistence.** No database, no job queue, no server-side
   recipe identity. This is deliberate and it constrains what
   `Idempotency-Key` can mean (see `contracts.md`).
4. **`src/anylist/client.ts` still describes the recipe id as "server-assigned"**
   in a comment, and two test names repeat it. Research disproved this. The
   wording is a Wave 1 correction; no production source was changed by this
   amendment.
5. **`CLAUDE.md` still states the `prepTime`/`cookTime` zero-persistence claim**
   that research disproved. It was outside the list of documents to update in
   this amendment and is flagged rather than changed.
6. **`413` and `415` are not returned today.** An oversized body currently
   yields `500` and a wrong content type yields `400`, because the error handler
   maps every non-400 status to 500. The approved contract requires distinct
   codes. Verified by inspection of the running server.
7. **No response carries a request ID today.** `X-Request-Id` is not set on any
   response.
