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
are all frozen. See ADR-010 through ADR-015.

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

**First task, before implementing idempotency:** compare the smallest
appropriate **Vercel-compatible durable stores** and propose one with evidence.
An in-process map is explicitly unacceptable. The semantics are frozen; only the
storage choice is open.

**Must not:** recompute `confidence`/`warnings` on export (ADR-010); auto-retry
`createRecipe` after an ambiguous write (ADR-012); implement YouTube ingestion;
apply the YouTube enum change without approval.

### 2. AnyList production research

**Owns:** research output only. **Writes no production code** outside
`src/anylist/` and does not change the `RecipeSaver` interface without approval.

Questions to answer with evidence:

- The `prepTime`/`cookTime` zero-persistence bug: is it fixable upstream, is
  there a working field combination, or is the note workaround permanent?
- Account limits: is anything rate-limited, and does the free tier
  (`isPremiumUser: false`) constrain recipe count or features?
- Token reuse: `getTokens()`/`fromTokens()` exist and we deliberately do not use
  them. What would safe reuse look like, and what does a fresh login per request
  actually cost in latency?
- Failure modes under real conditions: duplicate names, very long fields,
  unusual characters, concurrent writes.
- Dependency risk: one maintainer, one published version, an unauditable native
  binary. What is the contingency?

### 3. Independent QA / regression

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

## Still open

- **The YouTube enum source change awaits approval.** Written out exactly in
  `contracts.md`. Three touch points, one of which is a test that inverts.
- **Consumer/user authentication** must be decided before broad distribution.
  Not a Wave 1 blocker; Wave 1B must not harden around the static token.
- **Whether an unimplemented-but-canonical platform deserves a distinct status
  code** (`501` rather than `400 Unsupported platform`). Separate contract
  change, not proposed.
