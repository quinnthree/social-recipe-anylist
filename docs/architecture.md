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
4. **AnyList `prepTime`/`cookTime` currently persist as `0`** due to an upstream
   bug in `@anylist-napi/anylist-napi`. Times are preserved in the recipe note
   as a workaround.
