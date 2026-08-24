# Handoff — Wave Plan

Status: **Milestone 4 complete and verified live.** The private Vercel smoke
test passed end to end on 2026-08-24. Broad consumer release remains blocked by
ADR-023.

Last updated: 2026-08-24.

## Where things stand

### Integration state

`d21432a` on `integration/m4`, with QA-025 resolved.

- **1132 tests passing**, 0 failing
- **28 intentionally skipped** live-external tests
- typecheck clean

### Live verification — PASSED (2026-08-24)

Private Vercel smoke test. Everything below was observed against a deployed
environment, not inferred from a local run.

**Platform**

- `integration/m4` deployed successfully
- Node 22 runtime path works
- Fastify default handler works
- `src/app.ts` entrypoint works
- `GET /health` returns 200
- `X-Request-Id` present on responses
- region `iad1` confirmed
- `maxDuration` configured as 120 in `src/app.ts`

**Extraction**

- live TikTok `POST /api/imports` → 200 with a canonical Recipe
- live Instagram `POST /api/imports` → 200, after the crawler User-Agent fix
- live Anthropic parsing worked
- request IDs and telemetry worked

**Redis / idempotency**

- `UPSTASH_REDIS_REST_*` selected live
- a first AnyList login failure reached `FAILED_SAFE`
- retry with the same key succeeded safely
- `COMPLETED` replay returned `idempotent: true`, `originalRequestId`, and the
  same saved AnyList ID
- **no second AnyList recipe was created**
- same key with a changed body → `409 Idempotency key conflict`

This is the first evidence that the state machine behaves correctly against a
real shared store rather than the in-memory one. Note what it does **not**
establish: the transitions were exercised by hand, in sequence. Atomicity under
genuine concurrency is still unproven — see the live-gated item below.

**AnyList**

- native `@anylist-napi` loaded successfully on Vercel Linux
- login succeeded
- `createRecipe` succeeded
- post-save verification succeeded
- the saved recipe ID was returned

**Instagram**

- a browser-shaped User-Agent no longer receives Open Graph metadata
- the honest `SocialRecipeBot` crawler User-Agent restored it
- redirect and interstitial security policy remained unchanged

### What is built

Milestones 1–3 (extraction → canonical Recipe → verified AnyList save, CLI and
local API) plus the Milestone 4 production API: the `POST /api/imports` /
`POST /api/exports/anylist` split, durable idempotency with state-dependent
retention, request IDs, `schemaVersion`, the 409/413/415 error contract, the
minimum-usability gate at the shared service boundary, semantic inbound
validation, typed AnyList errors, and Instagram redirect/interstitial hardening.

### Remaining items — none blocking promotion

- **Automated live Redis conformance is opt-in / live-gated.** The
  `IdempotencyStore` conformance suite runs against the in-memory
  implementation; the Upstash implementation is covered only by the 28 skipped
  live-external tests. The smoke test proved the transitions by hand, in
  sequence — **atomicity under genuine concurrency is still unproven by
  automation.**
- **The selective retry matrix is deferred** until upstream typed failure seams
  exist. Until then the conservative mapping in ADR-020 stands: only
  `login_failed` is `FAILED_SAFE`.
- **Consumer authentication is designed and not built** (ADR-026, ADR-027;
  `contracts.md` Part 3). Nothing is implemented — see "Phase 5E" below.
- **YouTube ingestion**, and the **iOS app**.

### Blocking broad consumer release

**Native AnyList stderr leakage (ADR-023) remains unresolved and is the release
blocker.** On failed login the native library writes response metadata —
including `set-cookie` values — directly to stderr, ahead of any JavaScript
redaction. On a deployed host that reaches platform logs. Private smoke testing
with known-good credentials is acceptable; broad distribution is not, until this
is mitigated.

Consumer authentication is **no longer an open decision** — it is designed and
unimplemented (ADR-026). The constraint it was opened for still stands: the
static `RECIPE_API_KEY` must not ship in an App Store binary.

## Completed: private Vercel smoke test

Ran 2026-08-24 against a private Vercel environment, a real Upstash instance,
and a real AnyList account. Results above.

The policy reminders it was run under, retained because they apply to every
future live run:

- Do **not** configure production `ANYLIST_EMAIL` / `ANYLIST_PASSWORD` in Vercel
  **Preview** environments. Preview may exercise extraction paths only; live
  AnyList export verification is Production or manual.
- Watch platform logs for native stderr output on any failed-login path
  (ADR-023). That observation is part of the smoke test, not a side note.
- Record `elapsedMs` and the phase split. These are the inputs to the
  deployment-timeout decision, and this is the first chance to measure them
  outside localhost.
- Redis conformance under real concurrency is unproven until this run. The
  atomic `NEW → IN_PROGRESS` claim and the stale-lease → `AMBIGUOUS` transition
  are the two behaviours worth deliberately provoking.

## QA follow-ups

### QA-025 — RESOLVED (2026-08-24)

The minimum-usability gate trimmed the **title** but counted `ingredients` and
`instructions` **structurally**, so `instructions: ["   "]` satisfied it. The
canonical schema's `min(1)` admits such strings, so extraction output could
reach the gate in that shape.

Fixed in `src/app/minimum-recipe.ts`: entries are now counted by meaning.

```ts
recipe.title.trim().length > 0 &&
recipe.ingredients.some((i) => i.name.trim().length > 0) &&
recipe.instructions.some((s) => s.trim().length > 0)
```

**One** meaningful entry is sufficient — a list that is mostly blank but holds a
real ingredient is still a recipe, and rejecting it would discard usable
extractions. The check inspects and never rewrites: no trimmed value is written
back and no field is normalised, so the recipe that passes is identical to the
one that entered.

Because the gate lives at the shared import-service boundary (ADR-019, QA-003),
the legacy `POST /api/import` and production `POST /api/imports` are held to it
identically. Still not a confidence gate.

### Redis conformance is live-gated

The `IdempotencyStore` conformance suite passes against the in-memory
implementation. The Upstash implementation is covered only by the 28 skipped
live-external tests. **Conformance is not proven for the store we will actually
deploy** until those run against a live instance during the smoke test.

## Phase 5E — consumer authentication (design only, 2026-08-24)

**Documentation and contract only. No code exists.** No registration route is
mounted, no consumer credential can be minted, and `RECIPE_API_KEY` remains the
only credential the server accepts. Reading this section is not evidence of an
implementation.

Approved and written up in `contracts.md` Part 3, ADR-026, and ADR-027:

- **Anonymous, installation-scoped, server-minted opaque bearer credentials.**
  No account, no email, no password, no Apple ID, and no client-supplied
  installation identifier — the server mints the identity.
- Token `sr1_<clientId>_<secret>`; the server stores only a SHA-256 digest of
  the secret and compares in constant time.
- Long-lived until revoked. A credential that never authenticates is cleaned up
  after 7 days.
- `RECIPE_API_KEY` keeps working for CLI, smoke tests, and private tooling, and
  skips the store lookup entirely.
- `429 Too many requests` enters the contract, with one fixed error string.
  Registration is limited per IP and globally; consumer principals are metered
  per client (20 imports/day, 40 exports/day).
- App Attest and DeviceCheck are **not** V1 requirements.

Two consequences worth carrying into implementation. Consumer auth makes Redis
a dependency of **every** consumer request rather than only exports, and it
fails closed — that was chosen over a validation cache so revocation is
immediate. And the public registration route **must not be deployed before the
rate limits and quotas exist** (M5E-B3); the endpoint mints credentials to
anyone who calls it.

Sequencing: **M5E-B1** token primitives and store, **B2** principal
authentication and legacy-key coexistence, **B3** public registration with
proxy trust and limits, **B4** deploy and private smoke, **M5E-C** the iOS
Keychain and bounded 401 recovery. The public route is built last, on purpose.

**This does not unblock broad consumer release.** ADR-023 is a separate gate.

## Rules for all parallel agents

1. **Contracts are frozen.** ADR-008 applies. No agent changes the canonical
   Recipe schema, API shapes, error envelope, or error codes without approval.
   Raise it; do not implement it.
2. **Read `product-scope.md` before proposing anything.** The out-of-scope list
   is a list, not a suggestion.
3. **Nothing in `contracts.md` Part 2 is implemented.** Do not build against it
   as if it were.
4. **Redaction rules are non-negotiable.** No provider errors, stacks,
   credentials, or tokens in responses or logs, ever.
5. Every workstream ends with `npm test` and `npm run typecheck` passing.

---

## Wave 1 — three parallel workstreams

These three can run concurrently because their file ownership does not overlap.

### 1. Backend production foundation

**Owns:** `src/app/`, `src/http/`, `src/server.ts`.

Implements the approved Part 2 contracts:

- Split `POST /api/imports` (extraction only, returns the full canonical
  Recipe) and `POST /api/exports/anylist` (consumes a canonical Recipe).
- Keep `POST /api/import` working for CLI and internal use.
- Request IDs: generate or adopt `X-Request-Id`, echo in every response and log
  line.
- Structured telemetry per `contracts.md`, including the phase split.
- Inbound validation of client-supplied canonical Recipes.
- `schemaVersion: 1` on production requests and successful responses, with
  strict inbound validation and rejection of unsupported versions (ADR-011).
- `Idempotency-Key` with the frozen semantics and states (ADR-012).

**Storage is now decided:** Upstash Redis via the Vercel Marketplace, behind an
`IdempotencyStore` abstraction, atomic transitions (ADR-017). Required on
`POST /api/exports/anylist` only.

**Retention is state-dependent (ADR-025, QA-021)** — do not implement a flat
24-hour TTL, which would let a key return to `NEW` by ageing and permit a second
write. 24h for `COMPLETED`/`FAILED_SAFE`; **30 days for `AMBIGUOUS`**;
`IN_PROGRESS` carries an explicit `leaseExpiresAt` distinct from its record TTL,
and a stale lease transitions atomically to `AMBIGUOUS` **before** any new claim
can be made.

Also in scope, all newly approved:

- Request fingerprint: validate → normalise → deterministic serialise → SHA-256
  (ADR-018). Never compare raw bytes.
- `X-Request-Id` on **every** response, plus `originalRequestId` on replays.
- `409` (three distinct messages), `413`, `415`. **These do not work today** —
  an oversized body currently returns 500 and a wrong content type returns 400.
- Body limits: 8 KB for both import routes, 64 KB for export.
- Minimum usable recipe gate: non-blank title + ≥1 ingredient + ≥1 instruction
  (ADR-019). Not a confidence threshold. Implement at the **shared
  import-service boundary**, not in the route, so the legacy
  `POST /api/import` path is covered too (QA-003). Do not remove that route.
- Semantic non-blank validation at the API boundary (QA-023, ADR-024):
  trimmed non-blank `title`, ingredient `name`, required `rawText`, and each
  instruction; nullable `quantity`/`unit`/`preparation` preserved, but not
  whitespace-only when non-null.
- Inbound hardening: strict bodies, whitespace-only titles rejected,
  `http:`/`https:` only, `maxMinutes < minMinutes` rejected (ADR-024).
- `AnyListError.code` and the state mapping in ADR-020.

**Must not:** recompute `confidence`/`warnings` on export (ADR-010); auto-retry
`createRecipe` after an ambiguous write (ADR-012, ADR-020); treat a stale
`IN_PROGRESS` as retryable (ADR-012 as amended); introduce a confidence
threshold (ADR-019); build rollback or Undo on `deleteRecipe()` (ADR-021); store
application data in Redis (ADR-017); implement YouTube ingestion; change parser
contracts for telemetry (`inputTokens`/`outputTokens` may stay `null`).

**QA-020 — fixed, pending merge.** `buildNote()` rendering `{40, 40}` as
`"40–40 minutes"` is resolved by commit **`8e921b8`** on
`research/anylist-auth-session`. **That branch is not merged to `main`**, so the
defect is still present on `main`. Merge it before or alongside the ADR-024
validation work.

**Already corrected (2026-08-21):** the "server-assigned" wording in
`src/anylist/client.ts` and the affected test descriptions, plus the stale
`CLAUDE.md` claims. Comments and names only. Note that `getRecipeById` loads the
full user-data blob and filters client-side, so verification is not a cheap
targeted read — relevant if export latency becomes a concern.

### 2. AnyList production research — round 2

**Owns:** research output only. **Writes no production code** outside
`src/anylist/` and does not change the `RecipeSaver` interface without approval.

Round 1 is complete; findings are recorded in `architecture.md` and ADR-020
through ADR-023. Remaining questions:

- **Native stderr leakage (highest priority).** Do failed and restored-token
  flows produce the same `set-cookie` leakage observed on failed login? This
  gates broad deployment (ADR-023).
- Can native stderr be intercepted or suppressed at all from JavaScript, given
  the library writes to the descriptor directly?
- Account limits: is anything rate-limited, and does the free tier
  (`isPremiumUser: false`) constrain recipe count or features?
- Failure modes under real conditions: duplicate names, very long fields,
  unusual characters, concurrent writes.
- Dependency risk: one maintainer, one published version, an unauditable native
  binary. What is the contingency?

**Settled, do not re-litigate:** deletion is unreliable (ADR-021); recipe ids are
client-generated (ADR-021); `prepTime`/`cookTime` do persist correctly, and the
note behaviour stays as conservative compatibility (ADR-021 context); token
restore works but does not reduce credential risk (ADR-022).

### 3. Independent QA / regression — round 2

Round 1 established a **golden corpus** labelled `ZERO_EDIT_EXPECTED`,
`EDIT_EXPECTED`, and `FAIL_EXPECTED`, plus a current baseline. Key finding:
**warnings do not automatically imply that editing is required**, and current
`confidence` does not correlate reliably enough to gate acceptance (ADR-019).

The golden corpus is now the **durable extraction-quality benchmark**. Any
future threshold must be justified against it. Do not introduce one based on
current scores.

Remaining scope:

**Owns:** test files and QA tooling. **Does not modify production source.**

- Lock in current behaviour before the split lands, so regressions are visible:
  CLI success and `--dry-run` output, error envelopes, status codes, stdout
  cleanliness, redaction.
- Adversarial extraction cases: captions with no recipe, ranges, compound units,
  emoji-heavy text, non-English text, missing servings and times.
- Prove the redaction guarantees hold across every failure path.
- No live TikTok, Anthropic, or AnyList calls in automated tests.

---

## Wave 1B — iOS

**Begins immediately after the production API contracts are approved and
frozen.** Not before: a thin client (ADR-004, ADR-005) is defined entirely by
the contract it calls, so starting early means building against a moving target.

Scope: Share Extension capture → main app review/edit → export → result. No
extraction logic, no AnyList credentials, no business rules.

Wave 1B may start while Wave 1 backend work is still in progress, provided the
contract is frozen. The contract is the dependency, not the implementation.

---

## Previously-blocking ambiguities — now resolved

| Question | Resolution |
|---|---|
| Idempotency vs. no persistence | Durable shared store required; semantics frozen, storage chosen by the Backend agent (ADR-012) |
| `confidence`/`warnings` after edit | Extraction-time assessment; never recomputed (ADR-010) |
| Canonical Recipe as inbound contract | `schemaVersion: 1`, strict validation (ADR-011) |
| Provenance field immutability | Contract/UI invariant, explicitly not server-verifiable (ADR-013) |
| Static bearer token | Prototype-only; must not ship in an App Store binary (ADR-014) |
| YouTube | Canonically supported, ingestion deferred; enum change proposed not applied (ADR-015) |

## Preview environment policy

Do **not** configure production `ANYLIST_EMAIL` / `ANYLIST_PASSWORD` in Vercel
Preview environments. Until a disposable AnyList account or session exists,
Preview may exercise **extraction paths only**; live AnyList export verification
is **Production or manual** only.

## Still open

- **The YouTube enum source change awaits approval.** Written out exactly in
  `contracts.md`. Three touch points, one of which is a test that inverts.
- **Consumer authentication is decided (ADR-026, ADR-027) and unimplemented.**
  Building it is M5E-B. Until then the static token is the only credential, and
  the iOS client must not harden around it.
- **Whether an unimplemented-but-canonical platform deserves a distinct status
  code** (`501` rather than `400 Unsupported platform`). Separate contract
  change, not proposed.
- **Native stderr mitigation** (ADR-023). Gates broad deployment, not Wave 1.
- **Instagram public-endpoint hardening** — redirect re-validation and
  login-wall detection, in the adapter, not the HTTP layer. Required before
  public exposure; not implemented and not part of this amendment.
- **The multimodal escalation trigger is undetermined** (ADR-009 as amended).
  It is no longer assumed to be confidence-based.
