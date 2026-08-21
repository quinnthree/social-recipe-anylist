# Decision Record

Architecture decisions for this project. Each entry states the decision, why it
was made, and what it forbids. Superseding an accepted ADR requires explicit
approval.

Last updated: 2026-08-21.

---

## ADR-001 — The canonical Recipe is provider-neutral

**Status:** Accepted

**Decision.** The canonical Recipe models a recipe as extracted from a social
post. It carries no destination-specific fields, encodes no destination
limitations, and is never shaped to match AnyList.

**Why.** Destination formats are lossy in ways the source is not. AnyList stores
a single integer for cook time; sources routinely state "35–40 minutes". If the
model matched the destination, that information would be destroyed at extraction
time, before any human could review it. Keeping the model neutral means loss
happens once, late, and visibly — in the adapter.

**Consequences.** `prepTime`/`cookTime` are ranges. Ingredients keep `rawText`
even though no destination consumes it. `confidence` and `warnings` are ours and
are never exported. Adding a field because AnyList wants it is a violation.

---

## ADR-002 — AnyList is an export adapter, not the model

**Status:** Accepted

**Decision.** AnyList integration lives entirely behind the `RecipeSaver`
interface in `src/anylist/`. No other layer imports it, references its types, or
knows it exists.

**Why.** This has already paid for itself. Migrating from `anylist@0.8.6` to
`@anylist-napi/anylist-napi` — a complete change of library, transport, error
model, and identity semantics — touched only the adapter and its tests. The
extraction pipeline and CLI orchestration needed no changes.

**Consequences.** Destination-specific compromises are adapter-local: the
range-to-lower-bound flattening, the note-based time preservation, the dropping
of `rawText`, the seconds-to-minutes correction. A second destination is a new
adapter, not a refactor.

---

## ADR-003 — Extraction is text-first

**Status:** Accepted

**Decision.** Extraction reads source text only: TikTok captions via oEmbed,
Instagram Open Graph metadata. No audio, no video, no frames.

**Why.** Captions carry the full recipe often enough to be useful, and cost
milliseconds and a single model call. Transcription and frame analysis cost
orders of magnitude more per import. Building them first would optimise a path
we had not yet proven was necessary.

**Consequences.** Instagram is best-effort and fails cleanly behind a login
wall — that failure is designed, not a bug. Some recipes will not be extractable
from text, and must fail visibly rather than being guessed at. Nothing is ever
inferred that the source did not state.

---

## ADR-004 — iOS stays thin

**Status:** Accepted

**Decision.** The iOS app is transport and presentation. It sends URLs, renders
the canonical Recipe for review, sends the edited Recipe back, and displays the
outcome. It contains no extraction logic, no platform detection, no
normalisation, no AnyList knowledge, and no AnyList credentials.

**Why.** Server logic ships in minutes; app logic ships when review allows. Every
rule about what a recipe *is* will need to change as we see real sources. Those
rules must live where they can be corrected same-day. Credentials in a client
binary are also simply unsafe.

**Consequences.** New platforms, extraction improvements, and mapping fixes
require no app release. The app cannot function offline, which is acceptable —
extraction is a network operation regardless.

---

## ADR-005 — The Share Extension stays thin

**Status:** Accepted

**Decision.** The Share Extension captures the shared URL and hands off. It does
not extract, does not host the review UI, and does not call AnyList.

**Why.** Share Extensions run under hard memory limits and can be terminated by
the system at any point. A multi-second extraction with a review UI inside one is
a reliability problem, not a UX choice.

**Consequences.** Review and edit happen in the main app or a subsequent step,
never inside the extension. This is a stronger constraint than ADR-004 and it
holds even if the app grows.

---

## ADR-006 — AnyList-first V1 positioning

**Status:** Accepted

**Decision.** The product is "save recipes from TikTok, Instagram, and YouTube
directly to AnyList." AnyList is the only V1 destination and the product is built
around it.

**Why.** A general recipe manager competes with mature products on features we
have no advantage in. Getting a social recipe into the tool someone already uses
is a narrow job we can do well, and it is the job that motivated this project.

**Consequences.** Meal planning, grocery lists, a recipe library, nutrition, and
pantry features are out of scope — see `product-scope.md`. AnyList owns the
recipe after export. Notably, this does **not** contradict ADR-001: neutral
model, opinionated product.

---

## ADR-007 — Extraction and export are separate production concepts

**Status:** Accepted (contract proposed, not implemented)

**Decision.** In the production API, extraction (`POST /api/imports`) and export
(`POST /api/exports/anylist`) are distinct operations with the user's Review/Edit
step between them. The existing one-shot `POST /api/import` may remain for CLI
and internal use.

**Why.** Review/Edit is a product requirement (`product-scope.md`), and a
one-shot endpoint cannot express it — it commits to AnyList before the user has
seen anything. Separating them also means a failed export can be retried without
paying for extraction again.

**Consequences.** The canonical Recipe becomes an **inbound** contract, which it
has never been. This is why the production contract carries `schemaVersion: 1`
and uses strict inbound validation (ADR-011). The concrete contracts in
`contracts.md` Part 2 are **proposed, not implemented**.

---

## ADR-008 — Cross-boundary contract changes require oversight

**Status:** Accepted

**Decision.** Changes to the canonical Recipe schema, the API request/response
shapes, the error envelope, or the error-classification codes require explicit
approval before implementation. Parallel agents may not change them
unilaterally.

**Why.** These are the seams multiple agents and the iOS client build against
simultaneously. A unilateral change to the `Platform` enum or an error code
silently breaks work in another workstream, and the break may not surface until
integration.

**Consequences.** Adding YouTube is a cross-boundary change: it alters the
canonical `Platform` enum. Agents that need a contract change must raise it
rather than implement it. Contract changes are made in one place and propagated
deliberately.

---

## ADR-009 — Multimodal extraction is deferred and gated

**Status:** Accepted

**Decision.** Audio transcription and video frame analysis are deferred. When
introduced, they run only as an escalation from the text-first path, triggered by
a confidence or completeness threshold, never by default.

**Why.** Cost and latency per import are orders of magnitude higher. Most recipes
that can be extracted from a caption should be, cheaply. Escalation should be the
exception, and should be measured before it is built.

**Consequences.** `confidence` and `warnings` must be computed deterministically
and must stay meaningful — they are the future gate, which is why the model is
not permitted to report its own confidence. Telemetry on confidence
distribution is a prerequisite for choosing the threshold.


---

## ADR-010 — Confidence and warnings are an extraction-time assessment

**Status:** Accepted

**Decision.** `confidence` and `warnings` describe what the extraction engine
originally produced. They are **not recomputed** after the user edits the
recipe. The export path validates the edited recipe independently and never
treats a stale extraction warning as an export failure.

**Why.** Recomputing after a human correction would destroy the signal's meaning.
These values are the intended gate for expensive multimodal extraction
(ADR-009); if a user's manual fix improves the score, the gate would learn that
extraction is better than it is. Keeping them historical also makes them honest
telemetry: "what did the cheap path actually manage on its own."

**Consequences.** A recipe carrying warnings is a normal, exportable recipe. The
iOS Review UI may mark warnings resolved in its own presentation layer; the
canonical values are unchanged. `RecipeSchema` is **not** being redesigned to
separate extraction assessment from recipe content during this revision — that
remains a possible future change, deliberately deferred.

---

## ADR-011 — The production API is versioned and strictly validated

**Status:** Accepted (proposed contract, not implemented)

**Decision.** Production requests and successful responses carry
`schemaVersion: 1`. Inbound validation is strict: unknown keys are rejected,
and an unsupported version is refused rather than best-effort parsed.

**Why.** ADR-007 makes the canonical Recipe an inbound contract for the first
time, and ADR-004 puts a separately-released iOS client on the other side of it.
Client and server will drift. An explicit version makes that drift a clear error
instead of a silent misparse, and strict validation stops a client from relying
on fields the server quietly ignores.

**Consequences.** Adding a canonical field is a versioned change with a
migration path, not an edit. `POST /api/import` (the current one-shot endpoint)
is unversioned and stays that way as internal/proof convenience.

---

## ADR-012 — Idempotency requires durable shared state, and is not exactly-once

**Status:** Accepted (semantics frozen; storage not chosen)

**Decision.** `Idempotency-Key` is part of the production contract with the
semantics and the `NEW` / `IN_PROGRESS` / `COMPLETED` / `FAILED_SAFE` /
`AMBIGUOUS` states frozen in `contracts.md`. It requires durable, shared
storage. An in-process map is **explicitly unacceptable** on Vercel. The storage
implementation is deliberately **not** chosen in Wave 0.

**Why.** An in-process store is lost on restart and inconsistent across
instances — worse than nothing, because it presents a guarantee it cannot keep.
Choosing the store is an implementation comparison the Backend agent should make
with evidence, but the semantics must be fixed first so other workstreams can
build against them.

**Consequences.** No automatic retry of `createRecipe` after an ambiguous
external-write failure, ever. The `FAILED_SAFE` / `AMBIGUOUS` distinction is
load-bearing: only the former is retryable.

**This is explicitly not exactly-once against AnyList.** The AnyList API exposes
no idempotency key, so a write that landed but whose outcome we never learned
cannot be detected by protocol. It prevents *our* duplicates, not all duplicates,
and must never be described otherwise.

---

## ADR-013 — Source provenance is a contract invariant, not an enforced property

**Status:** Accepted

**Decision.** `source.url`, `source.platform`, and `source.creator` are
read-only provenance. The iOS Review UI must not offer normal editing of them.
For V1 we deliberately do **not** add import persistence, signed receipts, or
cryptographic enforcement to prevent a trusted first-party client from altering
them.

**Why.** The only client is our own, and the only user is the account holder.
Building enforcement machinery against a threat model that does not yet exist
would cost persistence and complexity that `product-scope.md` explicitly rules
out.

**Consequences.** Anyone reading the contract must understand this rests on
client cooperation and is **not server-verifiable**. If third-party clients or
untrusted callers ever appear, this ADR must be revisited before they do — not
after.

---

## ADR-014 — Static bearer auth is prototype-only

**Status:** Accepted

**Decision.** `RECIPE_API_KEY` is a single static bearer token for deployment
and prototype use. It is acceptable for the current Vercel proof and the CLI. It
**must not** ship inside a production App Store binary.

**Why.** A shared secret in a distributed client binary is extractable by anyone
who downloads the app, cannot be revoked per-user, and identifies nobody. It is
adequate only while the sole caller is the account holder's own machine.

**Consequences.** Consumer/user authentication is a future contract decision
required before broad distribution. Wave 1B may build against the static token
for development, but the iOS contract must not harden around it.

---

## ADR-015 — YouTube is canonically supported before it is ingestible

**Status:** Accepted (canonical value set updated; source change proposed, not applied)

**Decision.** The canonical platform value set is
`"tiktok" | "instagram" | "youtube"`. YouTube ingestion is **not** implemented
and is not part of this revision. The exact source change to align the code enum
is written out in `contracts.md` and awaits approval.

**Why.** YouTube is in the V1 promise. Fixing the contract now means the iOS
client, QA fixtures, and backend can be built against the final value set
instead of being revised mid-wave — which is precisely the churn ADR-008 exists
to prevent.

**Consequences.** For a period, a canonical value exists that no adapter
produces. Documentation must state canonical support and ingestion status
separately everywhere platforms are listed. A YouTube URL returns
`400 Unsupported platform` until an adapter exists; whether that should become a
distinct "not yet supported" signal is a separate, unproposed contract change.

**Applied 2026-08-21**, together with the Platform boundary cleanup below.

---

## ADR-016 — The canonical schema owns the platform vocabulary

**Status:** Accepted (applied 2026-08-21)

**Decision.** `src/recipe/schema.ts` owns the full platform vocabulary. The
social ingestion layer **derives** its narrower set with a type-only import
rather than restating it:

```ts
export type Platform = Extract<CanonicalPlatform, "instagram" | "tiktok">;
```

**Why.** Two same-named, hand-maintained string unions sat on either side of a
boundary that parallel Wave 1 agents will both touch — exactly the silent drift
ADR-008 exists to prevent. The duplication was discovered when widening the
canonical enum to add `"youtube"` produced no effect whatsoever in the social
layer.

**Consequences.** Adding a canonical platform without an adapter is safe and
silent, which is the normal case (ADR-015). Renaming or removing one is a
compile error on both sides. The adapter map is exhaustive by construction, so
no `Exclude<>` is needed. The import is type-only, so the social layer gains no
runtime dependency on the recipe layer.

**Note.** The enforcement lives in this derivation, **not** in the adapter map
typing. An earlier proposal claimed the latter; that claim was wrong and is
corrected in `contracts.md`.
