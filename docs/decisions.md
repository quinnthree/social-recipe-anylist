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

**Status:** Accepted. **Implemented** in Milestone 4 (`065d9c6`) and **verified live 2026-08-24** on Vercel.

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
and must stay meaningful, which is why the model is not permitted to report its
own confidence.

**Amended 2026-08-21.** This ADR originally named `confidence` as *the* gate.
QA has since established that current `confidence` does not correlate reliably
enough with whether a recipe needs editing to serve that role. The escalation
trigger is therefore **undetermined** — it may be completeness-based,
signal-based, or a revised score. `confidence` remains useful telemetry and an
input to that future decision, but it is no longer designated as the mechanism.
See ADR-019, which also removes it from the acceptance path.


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

**Status:** Accepted. **Implemented** in Milestone 4 (`065d9c6`) and **verified live 2026-08-24** on Vercel.

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

**Status:** Accepted. Storage chosen (ADR-017) and **implemented** in Milestone 4 (`065d9c6`). **Verified live 2026-08-24**: FAILED_SAFE retry, COMPLETED replay with no second write, and same-key/changed-body 409 all confirmed against a live Upstash instance. Automated conformance for the Upstash implementation remains live-gated.

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

**Amended 2026-08-21.** The storage question is now settled — see ADR-017. Two
rules were also tightened: `FAILED_SAFE → IN_PROGRESS` must be an **atomic
re-claim**, not just `NEW → IN_PROGRESS`; and a **stale `IN_PROGRESS` record does
not become retryable by ageing**. Absent positive evidence that `createRecipe`
was never reached, a stale `IN_PROGRESS` is treated as `AMBIGUOUS`. Expiry is
not evidence of safety.

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

**Status:** Accepted. Canonical value set updated and the source change **applied**. YouTube ingestion remains unimplemented by design.

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

---

## ADR-017 — Upstash Redis behind an IdempotencyStore abstraction

**Status:** Accepted (2026-08-21). Completes the open question in ADR-012. **Implemented** in Milestone 4 and **verified live 2026-08-24** — `UPSTASH_REDIS_REST_*` selected in the deployed environment. Automated conformance remains live-gated.

**Decision.** Export idempotency uses **Upstash Redis via the Vercel
Marketplace**, behind an `IdempotencyStore` abstraction. The store must support
atomic state transitions. **Retention is state-dependent — see ADR-025**, which
supersedes the flat 24-hour retention this ADR originally specified. Only
`POST /api/exports/anylist` requires durable idempotency; `POST /api/imports` is
read/compute-only and does not.

**Why.** ADR-012 established that durable, shared state is required and that an
in-process map is unacceptable on Vercel. Upstash is the smallest thing that
provides atomic compare-and-set with a TTL on that platform. The abstraction
exists so the choice is reversible without touching route logic.

**Consequences.** This is **request-coordination infrastructure only**. It is
not a general application database and does **not** reopen the no-database scope
decision in `product-scope.md`. Nothing about recipes is stored in it — only
idempotency records: state, fingerprint, recorded result, the originating
request id, and (per ADR-025) an explicit `leaseExpiresAt`. Anyone proposing to keep application data there is proposing a scope
change.

---

## ADR-018 — Idempotency compares a normalised fingerprint, not raw bytes

**Status:** Accepted (2026-08-21). **Implemented** in Milestone 4 (`065d9c6`) and **verified live 2026-08-24** — a same-key/changed-body replay returned 409.

**Decision.** "Same request" is decided by validating the request, normalising
it to the accepted canonical shape, deterministically serialising it, and
hashing with SHA-256. The fingerprint is stored on the idempotency record. Raw
HTTP bytes are never compared.

**Why.** Byte comparison makes JSON key ordering semantically significant. A
client that re-serialises an identical recipe — a different JSON encoder, a
round-trip through a Shortcut, a reordered field — would get
`409 Idempotency key conflict` for a request that is, by every meaning that
matters, the same. That is a false conflict the client cannot diagnose or fix.

**Consequences.** Validation must run **before** fingerprinting, so the hash is
over the accepted canonical shape rather than over whatever arrived. The
normalisation must be deterministic and stable, since changing it silently
invalidates every stored fingerprint.

---

## ADR-019 — The acceptance gate is a deterministic minimum, not a confidence threshold

**Status:** Accepted (2026-08-21). Amends ADR-009. **Implemented** in Milestone 4 at the shared import-service boundary (QA-003). QA-025 (blank entries satisfying the gate) resolved 2026-08-24 by `d21432a`: entries are counted by meaning, not presence — non-blank trimmed title, at least one meaningful ingredient name, at least one meaningful instruction. Still no confidence gate, and no normalisation added.

**Decision.** `POST /api/imports` succeeds only when extraction yields a
**non-blank title, at least one ingredient, and at least one instruction**.
Otherwise it returns the existing safe extraction-failure result. No confidence
threshold is introduced.

**Why.** QA built a golden corpus labelled `ZERO_EDIT_EXPECTED` /
`EDIT_EXPECTED` / `FAIL_EXPECTED` and established that current `confidence` does
not correlate reliably enough with whether edits are actually required. Gating
acceptance on a score that does not predict the thing it would be gating would
reject usable recipes and admit unusable ones, with no way for a user to tell
which had happened. The structural minimum is the honest test: can a person
cook from this at all.

**Consequences.** `confidence` and `warnings` stay extraction-time assessment
(ADR-010) and take no part in the accept/reject decision. **Warnings do not
imply that editing is required.** The golden corpus becomes the durable
extraction-quality benchmark, and any future threshold must be justified against
it rather than against intuition.

**Amended 2026-08-21 (QA-003).** The rule belongs at the **shared
application / import-service boundary** wherever practical, not in the
`/api/imports` route handler. Placing it in the route would leave the legacy
`POST /api/import` path writing obviously empty recipes to AnyList purely
because it predates `/api/imports` — the weaker standard applied to the path
that actually writes. `importRecipe()` is that shared boundary.
`POST /api/import` is **not** removed; it simply stops being exempt.

---

## ADR-020 — AnyList reports facts; the application decides retry safety

**Status:** Accepted (2026-08-21). **Implemented** in Milestone 4 as typed AnyList errors, and **verified live 2026-08-24** — a real login failure reached `FAILED_SAFE` and retried safely. The selective retry matrix stays deferred until upstream typed failure seams exist; the conservative mapping below is unchanged.

**Decision.** `AnyListError` carries a `code` of `login_failed`,
`create_failed`, `verify_unreadable`, or `verify_missing`. The AnyList layer
reports **what happened** and nothing more. The application maps codes to
idempotency states: `login_failed → FAILED_SAFE`; all three others →
`AMBIGUOUS`.

**Why.** Retry safety is not a property of the failure, it is a property of what
the failure implies about an external side effect — a judgement that needs the
idempotency context the adapter does not have. Only `login_failed` carries
positive evidence that no write was attempted. A `createRecipe` exception proves
nothing: the request may have been received and applied before the connection
died.

**Consequences.** Three of the four codes are non-retryable, deliberately. A
`createRecipe` exception must **never** be classified as safely retryable
without new evidence that no write could have occurred. This is the conservative
direction on purpose, because the alternative — an unnecessary duplicate — is
unfixable (ADR-021).

**Missing configuration uses `login_failed` for V1.** Absent or empty
`ANYLIST_EMAIL` / `ANYLIST_PASSWORD` reports `login_failed`, which deliberately
**collapses deployment misconfiguration and genuine credential failure into one
`FAILED_SAFE` class**. Safe — neither reached AnyList — but lossy for diagnosis:
an operator cannot distinguish "the secret is missing in this environment" from
"the password is wrong". A `config_missing` discriminator may be added if the
consumer or operations layer needs the distinction. Not required for V1.

---

## ADR-021 — No rollback and no Undo: AnyList deletion is unreliable

**Status:** Accepted (2026-08-21). RESEARCH-PROVEN.

**Decision.** Treat programmatic AnyList deletion as unsupported for V1. Do not
design automatic rollback, compensating transactions, or an Undo affordance
around `deleteRecipe()`.

**Why.** Measured: `deleteRecipe()` returns success **without removing the
recipe**, and multiple request shapes produced HTTP 200 with no deletion. A
rollback built on it would report success while leaving the duplicate in place —
worse than no rollback, because it would be trusted.

**Consequences.** Export idempotency is load-bearing rather than a nicety: a
duplicate we create cannot be cleaned up for the user. Correction happens in
AnyList itself. This is also why the `AMBIGUOUS` state refuses to retry.

**Related correction.** The AnyList recipe identifier is **client-generated** by
the library/protocol, not proven server-assigned. `createRecipe()` returning an
id is therefore **not** persistence proof, and post-save `getRecipeById()`
verification remains mandatory. Idempotency is not being redesigned around
caller-controlled ids. Earlier documentation in this repository claimed
server-assignment; that claim was wrong. A stale comment to that effect remains
in `src/anylist/client.ts` and is a Wave 1 correction.

---

## ADR-022 — Token storage does not eliminate credential risk

**Status:** Accepted (2026-08-21). RESEARCH-PROVEN.

**Decision.** Record that `fromTokens()` restores a usable authenticated client
without network validation, proven in a fresh process with `ANYLIST_EMAIL` and
`ANYLIST_PASSWORD` absent; that a restored session performed `getRecipes`,
`createRecipe`, and `getRecipeById`; that access tokens last ~3600 seconds and
refresh tokens ~730 days without rotating during a forced refresh; and that
multiple clients restored from one token blob operated concurrently without
interference.

The current `ANYLIST_EMAIL` / `ANYLIST_PASSWORD` model **remains** for the
private Vercel proof and is explicitly temporary. Connect/disconnect
architecture is not built now.

**Why.** It is tempting to read "the password is no longer technically required"
as "credential risk is solved". It is not. The stored refresh material is itself
a long-lived bearer credential with account-level authority — a roughly two-year
key to the account, which does not rotate, and which several clients can use at
once. That is a different risk shape, not a smaller one.

**Consequences.** Any future connect/disconnect design must treat stored session
material with the same seriousness as a password: encrypted at rest, revocable,
scoped, and never logged. **Do not describe token storage as eliminating
credential risk** in any document or commit message.

---

## ADR-023 — Pino redaction is not protection against native stderr

**Status:** Accepted (2026-08-21). RESEARCH-PROVEN. **Still unresolved as of
2026-08-24 — this is the blocker for broad consumer release.** The private
Vercel smoke test was run with known-good credentials specifically to avoid
provoking it, which is acceptable for a private run and is not a mitigation.

**Decision.** Record that on failed login the native Rust library writes
diagnostic data — including HTTP response metadata with `set-cookie` values —
**directly to stderr**, before any JavaScript logging or redaction can
intercept it. On a deployed host this reaches platform logs.

**Why.** Our redaction operates inside the Node process, on data we log. A
native library writing to a file descriptor is outside that boundary entirely.
Representing Pino redaction as complete protection would be a false security
claim in a document other people build against.

**Consequences.** Private smoke testing with known-good credentials is
acceptable. **Broad consumer deployment requires investigation and mitigation
first.** The AnyList research workstream must additionally test whether failed
or restored-token flows produce equivalent leakage. Note that the Milestone 2
migration removed the console-interception shim — there is currently no
JavaScript-side interception of native output at all.

---

## ADR-024 — Strict validation at the untrusted boundary, not everywhere

**Status:** Accepted (2026-08-21). **Implemented** in Milestone 4. QA-020 resolved and merged.

**Decision.** Consumer-facing API request bodies are strict: unknown keys are
rejected. Inbound hardening also rejects whitespace-only titles, restricts
`source.url` to `http:`/`https:`, and rejects `maxMinutes < minMinutes` while
permitting `maxMinutes === minMinutes`. Internal Zod objects are **not**
required to be globally strict.

**Why.** The security boundary is untrusted inbound API data, which is where
strictness buys something real. Making every internal object strict would cause
churn across the extraction pipeline for no safety gain, and churn during
parallel waves is itself a risk (ADR-008).

**Consequences.** The preferred producer form remains
`{ minMinutes: n, maxMinutes: null }`; our own extraction continues to emit it.

**QA-020 — resolved.** This ADR originally created a contradiction: accepting
`maxMinutes === minMinutes` while `buildNote()` in `src/anylist/mapping.ts`
treated any non-null `maxMinutes` as a range, so an inbound `{40, 40}` would
render `"40–40 minutes"`. Fixed by commit **`8e921b8`** ("Add typed AnyList
errors and exact-time mapping"), which renders a range only when
`maxMinutes > minMinutes`. **That commit currently lives on
`research/anylist-auth-session` and is not merged to `main`** — the defect is
still present on `main` until it lands.

**Amended 2026-08-21 (QA-023).** Non-blank validation is **semantic**, not just
`min(1)`: `title`, `ingredients[].name`, `ingredients[].rawText` where required,
and each `instructions[]` entry are trimmed and must be non-blank. For
`quantity`, `unit`, and `preparation` the **nullable model is preserved** —
`null` remains a meaningful "not stated" — but a non-null whitespace-only value
is not accepted as meaningful text. The canonical recipe structure is **not**
redesigned.

---

## ADR-025 — Idempotency retention is state-dependent; TTL is not a lease

**Status:** Accepted (2026-08-21), **implemented** in Milestone 4. Supersedes the flat 24-hour retention in
ADR-017 and completes ADR-012. Raised by QA as **QA-021**.

**Decision.** Retention depends on state:

| State | Record retention |
|---|---|
| `COMPLETED` | 24 hours (replay window); ordinary key reuse may follow, per implementation policy |
| `FAILED_SAFE` | 24 hours; retry via the atomic `FAILED_SAFE → IN_PROGRESS` transition |
| `IN_PROGRESS` | Not a plain 24-hour TTL; may hold a 30-day record TTL with a much shorter explicit `leaseExpiresAt` |
| `AMBIGUOUS` | **30 days**; returns `409 Export outcome unknown` throughout |

**Record TTL** and **execution lease** are distinct concepts. TTL preserves the
record. `leaseExpiresAt` says whether active execution is still expected. A
stale lease **does not delete the record**; it transitions the record atomically
to `AMBIGUOUS`, and that conversion must happen **before any new claim** can be
made against the key.

**Why.** The approved contract contained a genuine contradiction. It said a
stale `IN_PROGRESS` is not evidence of safety and must be treated as
`AMBIGUOUS`, and it said records expire after 24 hours. Under a flat TTL those
two rules collide: the record vanishes, the key reads as `NEW`, and a second
AnyList write happens **solely because time passed**. Expiry is not evidence.
The safety rule would have been silently defeated by the retention policy — the
worst kind of contradiction, because the system would look correct while
duplicating writes.

**Consequences.** Uncertainty is preserved rather than erased. An operator sees
`409 Export outcome unknown` for 30 days on an affected key, which is the
correct outcome: the answer is genuinely unknown, and `deleteRecipe()` cannot
clean up a duplicate if we guess wrong (ADR-021). Implementations must not use
record expiry as a liveness signal.

**Honest limit.** After 30 days the `AMBIGUOUS` record is gone and the key
becomes reusable, so a second write becomes possible again. Thirty days is a
pragmatic bound on how long we hold uncertainty, not a proof. **Do not claim
indefinite duplicate prevention.** True exactly-once protection remains
impossible while AnyList exposes no native idempotency key — this policy narrows
the window, it does not close it.
