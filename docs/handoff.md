# Handoff — Wave Plan

Status: **Milestone 4 complete and verified live.** The private Vercel smoke
test passed end to end on 2026-08-24. Broad consumer release remains blocked by
ADR-023.

Last updated: 2026-08-25.

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

## Phase 5E — consumer authentication (B1–B3 built, nothing deployed)

**Status as of 2026-08-25: the backend surface is complete and unverified in
production.**

`POST /api/client/register` exists in code and mints real credentials. Nothing
has been deployed, no live registration has ever happened, and no iOS build
uses any of it — that is M5E-C. The public paths are now `/health` and the
registration route, and nothing else.

Two things stand between this and a deployment, and neither is optional:

1. **Live Redis conformance has not been run** for either the credential store
   or the counter store. Passing in-process is not evidence about the stores
   that would guard a public credential mint.
2. **The client-address rule is unverified against the platform.** Per-IP
   registration limits rest on reading a forwarded header correctly, and that
   behaviour has only been reasoned about, not observed. The global ceiling
   does not depend on it, which is why it exists.

**M5E-B1 — implemented (branch `feature/m5e-auth-store`).**

- `src/client/token.ts` — minting, strict parsing, SHA-256 hashing, and
  constant-time verification for `sr1_<clientId>_<secret>`.
- `src/client/store.ts` — the `ClientCredentialStore` interface and the record
  model, plus the retention and refresh constants.
- `src/client/memory-store.ts` — in-process implementation, held to the same
  semantics as Redis rather than a looser approximation.
- `src/client/redis-store.ts` — Lua-backed implementation on the approved
  `client:v1:<clientId>` namespace.
- `tests/production/client-credential-contract.ts` — one conformance suite,
  run against the in-process store in normal CI and against real Upstash under
  the live gate.

One implementation detail is worth carrying forward because it is easy to get
wrong: **token parsing is positional, not delimiter-split.** `_` is a member of
the base64url alphabet, so roughly a third of minted tokens contain the
separator inside a component. Both components are fixed length, so position
resolves what splitting cannot. The approved format is unchanged.

**M5E-B2 — implemented (branch `feature/m5e-auth-principal`).**

- `src/http/principal.ts` — resolves an `Authorization` header to
  `{ kind: "internal" }` or `{ kind: "installation", clientId }`. The internal
  key is checked first and never reaches the store; a malformed installation
  token is rejected before a lookup rather than after one.
- The existing `onRequest` hook attaches the principal. **No handler was
  changed**, and none parses a credential.
- `src/client/lazy-store.ts` and `resolveClientCredentialStore()` wire Redis in
  through the same pattern the idempotency store uses. There is deliberately no
  in-memory fallback for production: absent a store, a well-formed installation
  token is *refused*, never accepted.
- Telemetry carries `principalKind` and, for a consumer, the public `clientId`
  — both `null` until authentication has actually succeeded, so a rejected
  caller cannot plant an identity in our telemetry.

Two behaviours worth knowing before reading the code:

**A store that cannot answer returns 500, not 401.** Unknown, wrong, and
revoked credentials are externally indistinguishable 401s, as the contract
requires. An outage is a different statement — and answering it with 401 would
tell every consumer client to discard a working credential and register again,
destroying credentials and stampeding registration at the same moment.

**The atomic `touch` is the final authority on revocation.** A credential
revoked between the read and the touch fails, even though the read saw it
active and the secret verified. That race is precisely what the store's
atomicity exists to close, and the resolver defers to it.

**M5E-B3 — implemented (branch `feature/m5e-auth-registration`).**

- `POST /api/client/register`, public, strict single-field body. Every limit is
  consumed **before** anything is minted, so a denied registration cannot leave
  an orphan credential behind.
- `src/ratelimit/` — fixed-window counters behind their own interface, separate
  from credentials because the access patterns share nothing: durable hashed
  records written rarely, versus disposable integers written on every request.
- Registration is limited to 5/hour and 20/day per address with a 20/minute
  global ceiling; consumer principals get 20 imports and 40 exports a day. All
  configurable; internal `RECIPE_API_KEY` traffic inherits none of it.
- `429 Too many requests`, one string for every limit.
- `src/http/client-ip.ts` — an explicit address rule rather than Fastify's
  `trustProxy`, taking the rightmost forwarded entry so a caller's invented
  entries change nothing.

Worth knowing before reading the code:

**A quota counts requests served, not writes performed.** An idempotent export
replay is charged like any other request. Simple and predictable, and it stops
replays being a free channel; idempotency still decides how many AnyList
recipes exist.

**Everything fails closed.** A counter store that cannot answer is not
permission: registration refuses with `500 Registration failed`, and a consumer
request refuses through its route's ordinary 500. Internal traffic never
touches those stores and is unaffected.

**Still unimplemented:** deployment and live smoke (B4); the iOS Keychain and
bounded 401 recovery (M5E-C).

**Live Redis conformance passes for all three stores** against production-class
Upstash: idempotency 28, credentials 19, counters 9, plus 24 offline harness
tests in the same directory — 80 passed, 0 failed, 1 capability-excluded.

**What the first live run exposed, and what it did not.** The idempotency suite
initially failed 12 of 28. The cause was entirely in the harness: the
conformance suite reasons in logical keys (`k1`, `k2`, `k3`) and the store uses
whatever key it is given verbatim, because namespacing is the route's job
(`storeKey()`). Against the in-process store that is harmless — every
`createStore()` builds a fresh `Map` — but against Redis every test shared one
physical key, so a case would claim `k1` as `req-original` and read back
`req-1` left by an earlier one. Live tests now map their keys under
`idemtest:v1:<uuid>:`, unique per store instance, and delete exactly the keys
they created. **No production idempotency semantics were changed, and none
needed to be**: the test keys were never in the `idem:v1:` namespace, so no real
record was ever read, written, or deleted.

**Retention is verified in two halves, by clock capability.** One case then
remained: *"lets a completed record expire once its retention window passes"*,
which fast-forwards an injected `now` by 24 hours. The in-process store models
retention against that argument and passes; Redis expires on wall-clock TTL,
which no argument moves, so the record was still there 159ms later. **Production
Redis was not defective** — it sets exactly the contracted 86400s.

The suite is now explicit about which half a target can prove:

- **Logical clock** (in-process): step past the window, watch the record
  disappear. This is where the expiration boundary itself is verified.
- **Wall clock** (Redis): ask what retention was actually applied and require
  it to be the contracted 86400s, positive, and not "no expiry".

Each run shows the inapplicable case skipped by name beside its replacement, so
the distinction is visible in the output rather than absorbed by a bare skip.
**Waiting 24 real hours is deliberately not part of B4.** Every other
idempotency semantic — replay, conflict, stale-lease conversion, concurrency,
holder-only completion, and the durability of AMBIGUOUS and abandoned
IN_PROGRESS records — is exercised directly against real Redis.

Live test state is isolated under `idemtest:v1:<uuid>:` and the exact keys
created are deleted afterwards. No production idempotency record was read,
written, or deleted at any point.

**Gates 1–3 are met. B4 is not complete**: the preview deployment, the client-IP
spoof gate, and the registration and quota smokes have not been run. The
in-process suites passing is not evidence about the stores that will be
deployed — atomicity is structural in memory and bought with Lua in Redis, and
only one of those runs in production. All three must be run and reported before
B4:

```
set -a; source .env; set +a     # or export the Upstash variables another way
QA_LIVE_EXTERNAL=1 npm test -- tests/live/
```

**`QA_LIVE_EXTERNAL=1` means run or fail, never run if convenient.** With the
flag set and Upstash unconfigured, the suites fail and the command exits
non-zero, naming the missing variables. Without the flag they stay skipped and
the normal run stays offline.

That distinction is load-bearing: the command previously exited 0 while
skipping everything, so a B4 gate read from its exit code could report a pass
for work that never happened. The credentials must reach the **test process** —
`.env` alone is not enough, because `dotenv` is loaded when a server is built,
not by the test harness. In practice that means running under the project's
environment, e.g. `vercel env run -e production -- sh -c '…'`.

**Live mode opens the network to Upstash and to nothing else.** The normal run
blocks every external call, and that is unchanged. The exception is deliberately
narrow because the command that runs these suites injects the **production**
environment: the same process is holding live Anthropic, AnyList, and Apify
credentials, and opening the network wholesale for a flag would put those one
accidental `fetch` away from being spent. The guard compares origins — never
prefixes — so a host that merely starts with the configured one is refused, and
a permitted request cannot become an escape by being redirected. A missing or
unparseable Upstash URL blocks everything rather than allowing anything. See
`tests/support/network-guard.ts`.

The approved contract is unchanged; see `contracts.md` Part 3, ADR-026, and
ADR-027 for what B2 and B3 must build.

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
