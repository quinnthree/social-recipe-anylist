# Handoff — Wave Plan

Status: proposed. Wave 1 is **not** started and must not begin until this and
the Part 2 contracts are approved.

Last updated: 2026-08-21.

## Where things stand

Milestones 1–3 are complete and live-tested: TikTok → extraction → canonical
Recipe → AnyList save → server-side verification → visible in the AnyList mobile
app, reachable from both the CLI and a local HTTP API. 144 tests pass;
typecheck is clean.

What does **not** exist: YouTube ingestion, the extraction/export split, any
persistence, idempotency, request IDs, `schemaVersion`, deployment, and the iOS
app.

The Wave 0 contract revision is complete: idempotency semantics, schema
versioning, source provenance, auth scope, and the canonical platform value set
are all frozen. See ADR-010 through ADR-016.

**Milestone 4 amendment (2026-08-21).** Backend planning, AnyList production
research, and independent QA are complete, and their findings are folded into
the contracts. See ADR-017 through ADR-024, and the RESEARCH-PROVEN section of
`architecture.md`.

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
`IdempotencyStore` abstraction, 24-hour retention, atomic transitions (ADR-017).
Required on `POST /api/exports/anylist` only.

Also in scope, all newly approved:

- Request fingerprint: validate → normalise → deterministic serialise → SHA-256
  (ADR-018). Never compare raw bytes.
- `X-Request-Id` on **every** response, plus `originalRequestId` on replays.
- `409` (three distinct messages), `413`, `415`. **These do not work today** —
  an oversized body currently returns 500 and a wrong content type returns 400.
- Body limits: 8 KB for both import routes, 64 KB for export.
- Minimum usable recipe gate: non-blank title + ≥1 ingredient + ≥1 instruction
  (ADR-019). Not a confidence threshold.
- Inbound hardening: strict bodies, whitespace-only titles rejected,
  `http:`/`https:` only, `maxMinutes < minMinutes` rejected (ADR-024).
- `AnyListError.code` and the state mapping in ADR-020.

**Must not:** recompute `confidence`/`warnings` on export (ADR-010); auto-retry
`createRecipe` after an ambiguous write (ADR-012, ADR-020); treat a stale
`IN_PROGRESS` as retryable (ADR-012 as amended); introduce a confidence
threshold (ADR-019); build rollback or Undo on `deleteRecipe()` (ADR-021); store
application data in Redis (ADR-017); implement YouTube ingestion; change parser
contracts for telemetry (`inputTokens`/`outputTokens` may stay `null`).

**Known bug to fix while implementing ADR-024:** `buildNote()` in
`src/anylist/mapping.ts` renders any non-null `maxMinutes` as a range, so an
inbound `{40, 40}` becomes `"40–40 minutes"`. Accepting that shape without
fixing the renderer produces wrong output.

**Stale comment to correct:** `src/anylist/client.ts` describes the recipe id as
"server-assigned"; research disproved this (ADR-021).

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
- **Consumer/user authentication** must be decided before broad distribution.
  Not a Wave 1 blocker; Wave 1B must not harden around the static token.
- **Whether an unimplemented-but-canonical platform deserves a distinct status
  code** (`501` rather than `400 Unsupported platform`). Separate contract
  change, not proposed.
- **Native stderr mitigation** (ADR-023). Gates broad deployment, not Wave 1.
- **Instagram public-endpoint hardening** — redirect re-validation and
  login-wall detection, in the adapter, not the HTTP layer. Required before
  public exposure; not implemented and not part of this amendment.
- **The multimodal escalation trigger is undetermined** (ADR-009 as amended).
  It is no longer assumed to be confidence-based.
