# QA Findings

Independent QA / regression, branch `test/production-regression`.
Last updated: 2026-08-21.

Every finding below is reproduced by a test in this repository. None of them has
been fixed: production source is read-only for this workstream, and the two that
are defects in shipped behaviour need oversight approval before anyone touches
them.

Severity means: **Defect** — wrong in code that ships today. **Gap** — correct
today, becomes wrong the moment a contract in `contracts.md` Part 2 is
implemented. **Observation** — worth knowing, no action implied.

| ID | Severity | Summary |
|---|---|---|
| QA-001 | Defect | A request body over 8 KB is reported as `500`, not a client error |
| QA-002 | Defect | An Instagram interstitial that carries *any* `og:description` is extracted, not rejected |
| QA-003 | Defect | Nothing applies a confidence floor: an empty recipe at confidence 0.1 is saved to AnyList and reported as success |
| QA-004 | Gap | `TimeRangeSchema` has no cross-field validation |
| QA-005 | Gap | The canonical Ingredient cannot express "optional" |
| QA-006 | Gap | `RecipeSchema` strips unknown keys instead of rejecting them |
| QA-007 | Gap | A whitespace-only `title` validates |
| QA-008 | Gap | `source.url` accepts `file:`, `javascript:`, and `data:` URLs |
| QA-009 | Gap | An ambiguous AnyList write is indistinguishable from a definite failure |
| QA-010 | Observation | Log redaction cannot be asserted in-process |
| QA-011 – QA-018 | Gap | Contract questions that cannot be turned into a test as written — see `production-api-test-plan.md` |
| QA-019 | Observation | The auth hook guards the prefix `/api/`, not `/api` |

---

## QA-001 — An oversized body is reported as a server error

**Severity:** Defect. **Reproduced by:** `tests/http/current-api.test.ts`,
"DEFECT QA-001: reports a body over the 8 KB limit as a 500".

`buildServer` sets `bodyLimit: 8 * 1024`. Fastify rejects an oversized body with
`FST_ERR_CTP_BODY_TOO_LARGE`, whose `statusCode` is `413`. The error handler in
`src/http/server.ts:111` maps it:

```ts
await fail(reply, statusCode === 400 ? 400 : 500, safeTextFor(statusCode));
```

Anything that is not exactly `400` becomes `500 Recipe import failed`. So a
request the client got wrong is reported as a server failure, and
`request.log.error` records it at error level.

Why it matters: it is the failure mode a Shortcut hits with a long URL, and a
`500` tells the client to retry something that will never succeed. It also
pollutes error-rate telemetry with client mistakes.

The same collapse applies to every non-400 client error Fastify can raise.
`415 Unsupported Media Type` is verified alongside it: `application/xml`,
`application/x-www-form-urlencoded`, and `application/octet-stream` all return
`500 Recipe import failed`. (`text/plain` does not — Fastify has a default
parser for it, so it reaches the Zod schema and correctly returns 400.)

**Fix requires approval:** it changes a status code, which `contracts.md`
freezes (ADR-008). The narrow change is to pass through 4xx statuses rather than
only 400, and to add the corresponding row to the error table.

## QA-002 — An Instagram interstitial with a description is extracted, not rejected

**Severity:** Defect. **Reproduced by:** the `instagram-login-blurb` fixture,
asserted in `tests/golden/ingestion.test.ts` and
`tests/golden/assessment.test.ts`.

`architecture.md` says Instagram "fails cleanly when it is [blocked]". That is
true only when the login page carries **no usable `og:description`**. The
adapter's entire test for a login wall is whether `captionFrom` returns null
(`src/social/instagram.ts:48`). Any interstitial that carries description
text — a sign-in blurb, an age gate, a region notice — passes that test, and its
boilerplate is sent to Claude as if it were a caption.

The corpus fixture uses Instagram's own sign-in copy. The result is a valid
canonical Recipe titled after the login page, with no ingredients and no
instructions, at confidence 0.1 — and, because of QA-003, a `200` and a write to
AnyList.

Two costs: a paid model call for text that is knowably not a recipe, and a junk
recipe in the user's account.

The clean-failure case is fixture `instagram-login-wall` and it works exactly as
documented. This finding is about the other branch.

**Needs a live check:** which interstitials Instagram actually serves, and with
what `og:description`, is a LIVE EXTERNAL gate item. The code-level fact — that
a non-empty description is always accepted — is verified here and does not
depend on it.

## QA-003 — There is no confidence floor anywhere in the pipeline

**Severity:** Defect. **Reproduced by:** `tests/golden/canonical-recipe.test.ts`,
"would happily export the login-page blurb as a recipe".

`assessExtraction` computes confidence and warnings, and nothing reads them. Not
`importRecipe`, not the CLI, not `POST /api/import`. A recipe with zero
ingredients, zero instructions, and confidence 0.1 maps to a well-formed AnyList
payload, is written, is verified, and returns:

```json
{"success":true,"recipe":{"title":"Instagram Login Page","confidence":0.1,"warnings":[...]},"saved":{"id":"..."}}
```

`success: true`, six warnings, and an empty recipe in the user's AnyList account.

This is the finding with the most direct bearing on the North Star metric. The
one-shot endpoint has no Review step, so nothing between extraction and AnyList
can catch it. ADR-009 already designates confidence as the future gate for
escalating to multimodal extraction; the same signal would serve as a floor
here, and today it serves as neither.

Note this is *not* an argument for rejecting recipes that merely carry warnings —
see QA-005 and ADR-010. An empty extraction is a different thing from an
incomplete one, and `ingredients.length === 0 && instructions.length === 0` is
the honest discriminator.

**Fix requires approval:** adding a failure mode is a contract change (a new
status/error row).

## QA-004 — `TimeRangeSchema` has no cross-field validation

**Severity:** Gap. **Reproduced by:** `tests/contract/canonical-recipe.test.ts`,
the two "INBOUND GAP" TimeRange tests.

Both of these validate:

```ts
{ minMinutes: 35, maxMinutes: 35 }   // contract: "An exact time is never encoded as min === max"
{ minMinutes: 40, maxMinutes: 35 }   // an upper bound below the lower bound
```

The `min === max` rule is real, stated in `CLAUDE.md`, `contracts.md`, and the
extraction prompt — and enforced **only by the prompt**. That is sufficient while
we are the only producer. It stops being sufficient at
`POST /api/exports/anylist`, where a client supplies the recipe.

A `.refine()` would express both, at the cost of the JSON-Schema serialisation
that `schema.test.ts` guards ("serialises to JSON Schema so the extraction call
cannot fail at runtime"). The likely resolution is to keep `TimeRangeSchema`
serialisable for the model and apply the refinement in the endpoint's inbound
schema only.

## QA-005 — The canonical Ingredient cannot express "optional"

**Severity:** Gap. **Reproduced by:** the `tiktok-optional-ingredient` fixture and
`tests/golden/canonical-recipe.test.ts`, "carries '(optional)' to AnyList only
through the ingredient note".

`Ingredient` is `{quantity, unit, name, preparation, rawText}`. "1/2 cup roasted
peanuts (optional)" has two possible homes:

- `rawText`, which is lossless — and which the AnyList adapter deliberately drops.
- `preparation`, which reaches AnyList as the ingredient note — and which nothing
  requires the model to use for this.

So whether the user's AnyList recipe says "optional" depends on a model choice
no schema constrains. The corpus pins the intended behaviour
(`preparation: "optional"`) so that a live check has something to compare
against.

Adding an `optional` field is a canonical schema change and therefore an ADR-008
decision, not a ticket. Recording the ambiguity is the deliverable here; the
product may reasonably decide "optional" is not worth a field.

## QA-006 — `RecipeSchema` strips unknown keys instead of rejecting them

**Severity:** Gap. **Reproduced by:** `tests/contract/canonical-recipe.test.ts`,
"strips unknown keys instead of rejecting them".

Zod object schemas strip by default. ADR-011 requires the opposite for inbound
production requests: "Unknown keys are rejected, not ignored." A client that
sends a field the server does not know would get a `200` and never learn its
field was discarded — exactly the silent misparse the ADR exists to prevent.

The fix belongs at the endpoint (a `.strict()` inbound wrapper), not in the
shared schema, because the same schema also validates model output where
stripping is harmless. The skipped specs in
`tests/production/exports-anylist-endpoint.test.ts` already assert the strict
behaviour at three levels: top-level body, recipe object, and ingredient object.

## QA-007 — A whitespace-only title validates

**Severity:** Gap. **Reproduced by:** `tests/contract/canonical-recipe.test.ts`,
"accepts a whitespace-only title".

`z.string().min(1)` counts characters. `"   "` is three characters. The same
applies to every `.min(1)` string in the canonical schema: `name`, `rawText`,
`quantity`, `unit`, `preparation`, and instruction steps.

Today the model produces titles, so this is theoretical. On the export path a
recipe titled `"   "` would be written to AnyList under that name. `.trim()`
before the length check, applied in the inbound schema, is the usual remedy.

## QA-008 — `source.url` accepts non-http schemes

**Severity:** Gap. **Reproduced by:** `tests/contract/canonical-recipe.test.ts`,
"accepts %s as source.url", and the matching end-to-end test in
`tests/failure-modes/pipeline-failures.test.ts`.

`z.string().url()` accepts anything `new URL()` parses, including
`file:///etc/passwd`, `javascript:alert(1)`, and `data:` URLs. On the extraction
path this is harmless: `detectPlatform` enforces http(s)
(`src/social/index.ts:36`) and rejects all three as `invalid_url` before any
request is made, which the failure-mode suite proves.

The export path has no `detectPlatform`. `source.url` is written directly to the
AnyList recipe's `sourceUrl` (`src/anylist/mapping.ts:20`), and a `javascript:`
URL rendered as a link by any client that displays it is the reason this is
worth pinning now rather than after.

`POST /api/import`'s body schema has the same looseness — `{"url":"file:///x"}`
returns 400 only because the pipeline rejects it, not because the endpoint did.

## QA-009 — An ambiguous AnyList write is indistinguishable from a definite failure

**Severity:** Gap. **Reproduced by:** `tests/failure-modes/pipeline-failures.test.ts`,
"FINDING QA-009: an ambiguous create timeout is indistinguishable from a
definite failure".

`AnyListRecipeSaver.save` wraps every `createRecipe` failure in the same
`AnyListError` with the same fixed message (`src/anylist/client.ts:52`):

```ts
} catch (error) {
  throw new AnyListError(withStatus(SAVE_FAILED, error));
}
```

A `400 Bad Request` (the write definitely did not land) and a timeout after the
request was sent (the write may have landed) produce an identical error, an
identical `ImportError` kind, and an identical `500`.

ADR-012 makes exactly this distinction load-bearing: `FAILED_SAFE` is retryable,
`AMBIGUOUS` must never be retried automatically. The adapter currently gives the
caller no way to tell them apart, so an idempotency layer built on top of it
could not populate its own state machine correctly.

This is **not** a defect today. There is no idempotency store and nothing
retries — the same suite proves `createRecipe` is called at most once on every
failure path. It is a prerequisite for `POST /api/exports/anylist`, and it is a
change to `src/anylist/`, which belongs to the AnyList research workstream.

Verification failures have the same shape and are arguably worse: `VERIFY_MISSING`
means the write was accepted and then could not be read back, which is the
textbook `AMBIGUOUS` case, and it is reported as an ordinary save failure.

## QA-010 — Log redaction cannot be asserted in-process

**Severity:** Observation. **Worked around by:**
`tests/http/logging-redaction.test.ts` and `tests/support/log-capture.child.ts`.

`ServerDeps.logger` is `boolean`. With `logger: true`, pino writes to file
descriptor 1 through `sonic-boom`, bypassing `process.stdout.write`, so a test
in the same process cannot capture it.

The workaround is a child process that builds the real server, drives it with
`app.inject()` — so no port is opened — and has its stdout read by the test.
That works and the redaction guarantees are proven: no `Authorization` value, no
API key, no AnyList credentials, no provider message, no stack traces, and the
recipe title but not its contents.

It costs about 2 seconds per suite run and one extra process. Widening
`ServerDeps.logger` to `boolean | LoggerOptions | Stream` would make it a normal
in-process assertion. That is a production-source change and is **not** proposed
here; the current arrangement gives full coverage without one.

## QA-019 — The auth hook guards `/api/`, not `/api`

**Severity:** Observation. `src/http/server.ts:53` returns early unless
`request.url.startsWith("/api/")`. A route registered at exactly `/api` would
therefore be unauthenticated. No such route exists, and `GET /api` returns the
standard 404 today. Worth knowing before anyone adds one.

---

## Not findings

Checked and correct, recorded so they are not re-investigated:

- **Auth runs before routing.** Unauthenticated requests to unknown `/api/`
  paths return `401`, not `404`, so routes cannot be enumerated.
- **`createRecipe` is never called more than once**, on any failure path,
  including verification failure.
- **A dry run never constructs the AnyList adapter**, so the native module is
  never loaded.
- **No Anthropic call is made when ingestion fails**, so a blocked Instagram post
  costs one HTTP request and nothing more.
- **Error text is a fixed string chosen by status.** Two different inputs
  producing the same failure produce byte-identical responses.
- **Timing-safe bearer comparison** hashes both sides first, so neither contents
  nor length leaks.
- **The canonical/ingestion platform split holds.** `RecipeSchema` accepts
  `"youtube"`; `detectPlatform` rejects a YouTube URL as `unsupported_platform`.
