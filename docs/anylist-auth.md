# AnyList Authentication and Session Architecture

Research output. **No production source changed.** Nothing recommended here is
implemented.

Scope: how authentication, sessions, and token material behave in
`@anylist-napi/anylist-napi@1.1.1`, and what that means for a stateless
deployment and a future iOS client.

Last updated: 2026-08-21.

## How to read this document

Findings are labelled:

- **Evidence** — observed directly, in a live run against a real AnyList
  account, or read from the library's own source.
- **Inference** — a conclusion drawn from evidence, stated as such.
- **Unknown** — not established. Listed in §16 rather than guessed at.

No real token, password, or session value appears anywhere in this document.
Token identities are 12-hex SHA-256 prefixes produced by
`experiments/lib/redact.ts`.

---

## 1. Current proven auth behaviour

What production does today (`src/anylist/client.ts`):

```
ANYLIST_EMAIL + ANYLIST_PASSWORD
  → AnyListClient.login(email, password)      one HTTPS round trip, ~345–400 ms
  → createRecipe(payload)
  → getRecipeById(id) to verify
  → client discarded when the process ends
```

`getTokens()` is never called, so no session material is persisted. Every CLI
run and every API request performs a full password login.

**Evidence.** The adapter's `fromEnvironment` builds a connect function that
calls `AnyListClient.login` per save, and nothing reads `getTokens()`.

Two premises in the assignment brief need correcting before anything else:

| Brief says | Actually | Source |
|---|---|---|
| "server-assigned AnyList ID" | The recipe id is generated **client-side** by the Rust crate (`generate_id()`, a UUIDv4 with dashes stripped) and sent as `PBRecipe.identifier`. The server never assigns it. | `anylist_rs-0.4.0/src/recipes.rs`, `RecipeBuilder::create` |
| `createRecipe()` returns the created recipe | It returns a **client-side echo** — the builder's own field values plus the id it just generated. No server read is involved. | same |

This is why the post-save `getRecipeById` verification is load-bearing: it is
the only thing in the pipeline that proves the write landed. That design was
right, for a reason slightly different from the one recorded.

---

## 2. Experiments performed

All scripts live in `experiments/`. They read credentials through
`ANYLIST_ENV_FILE` and never write credentials anywhere. See
`experiments/README.md` for how to run them.

| # | Script | What it establishes | Writes? |
|---|---|---|---|
| 00 | `00-describe-stored-tokens.ts` | Offline description of stored session material | no |
| 01 | `01-login-and-tokens.ts` | `login()` return shape, `getTokens()` shape, second-login behaviour | no |
| 02 | `02-restore-in-fresh-process.ts` | Password-free read + write + verify in a separate process | 1 recipe |
| 03 | `03-refresh-and-expiry.ts` | Auto-refresh, rotation, and the unrecoverable-session error | no |
| 04 | `04-recipe-deletion-probe.ts` | Why `deleteRecipe()` does nothing (5 payload shapes) | attempts deletes |
| 05 | `05-mapping-fidelity.ts` | Field-by-field round trip through AnyList | updates the probe |
| 06 | `06-failure-and-concurrency.ts` | Wrong-password surface; 4 concurrent restored sessions | no |
| 07 | `07-create-time-fields.ts` | Whether `createRecipe` zeroes `prepTime`/`cookTime` | 1 recipe |

Offline unit tests cover the research scaffolding itself:
`experiments/lib/redact.test.ts` (9 tests) and
`experiments/lib/protobuf.test.ts` (9 tests).

### Account state left behind

`deleteRecipe()` does not work (§13). Two probe recipes are therefore permanent
and **must be deleted by hand in the AnyList app**:

| Recipe id | Name |
|---|---|
| `30d740e7cf2f4fbab8ee8ffa9654feb8` | `ZZ-AUTH-RESEARCH-PROBE restore 2026-08-21T14:01:16.840Z` |
| `5ea34d80e368471ca814f9c2d71321af` | `ZZ-AUTH-RESEARCH-PROBE create-times 2026-08-21T14:14:03.832Z` |

Neither id is secret. `experiments/cleanup-probe-recipes.ts` finds any probe by
name prefix and reports what it could not remove.

---

## 3. Login findings

**`AnyListClient.login(email, password)` — Evidence.**

- Returns a `Promise<AnyListClient>`. The resolved value is a normal object with
  no own properties; all 55 methods live on the prototype.
- Mutates **no** global or module state. Each call produces an independent
  client with its own `client_identifier` (a fresh UUIDv4, dashes stripped) and
  its own `reqwest` HTTP client.
- Issues a distinct session every time. Two logins on the same credentials
  returned the **same `userId`** and **different** access and refresh tokens.
- Sessions are **additive, not exclusive**. After a second login, the first
  client kept working (12 recipes read successfully). Logging in does not
  invalidate other sessions.
- Latency: **345 ms**, **401 ms** across runs. One multipart POST to
  `https://www.anylist.com/auth/token` with `X-AnyLeaf-API-Version: 3`.
- A repeated login is required for every new process **only because we choose to
  do it that way** — see §5. Nothing in the protocol demands it.

**Wrong-password surface — Evidence.** The thrown error is:

```
Authentication failed: Login failed with status: 401 Unauthorized,
body: <html><title>401: Unauthorized</title><body>401: Unauthorized</body></html>
```

Our adapter already refuses to attach or read this (`AnyListError` carries a
fixed string), so it cannot reach a response.

**But the native library also writes to stderr itself, unconditionally.** On a
failed login `anylist_rs/src/login.rs` executes `eprintln!` three times, dumping
the status, the **full response header map** — including two `set-cookie`
headers — and the body. This bypasses Pino, bypasses our redaction, and bypasses
the CLI's stdout discipline, because it is emitted from Rust before any
JavaScript sees the failure.

The submitted password is **not** in that output: only *response* headers are
printed. The leak is noise and cookie material, not credentials. It is still
uncontrollable output from a dependency and belongs in the risk register (§14).

---

## 4. Token findings

`getTokens()` returns `SavedTokens`, a plain object with exactly four keys.

**Evidence**, from a live session:

| Field | Type | Shape | Notes |
|---|---|---|---|
| `userId` | string | 32 chars, `[0-9a-f]` | Stable across logins. Identifies the account. |
| `accessToken` | string | 347 chars, 3 segments | **A readable JWT.** |
| `refreshToken` | string | 345 chars, 3 segments | **A readable JWT.** |
| `isPremiumUser` | boolean | `false` on this account | §17 |

Neither token is opaque. Both decode as JWTs with an `alg`/`typ` header and the
claim set:

```
com.anylist.token_type, exp, iat, iss, jti, sub
```

Claim *values* are withheld here except the time claims, which are the finding:

| | `iat` → `exp` | Lifetime |
|---|---|---|
| access token | 1787320832.65 → 1787324432.65 | **3600 s — exactly one hour** |
| refresh token | 1787320832.65 → 1850392832.65 | **63 072 000 s — exactly 730 days** |

Two details worth recording. The time claims are **non-integer** — fractional
seconds, which is unusual for JWT and may confuse strict parsers. And the
`jti` claim means the server is in a position to track and revoke individual
tokens, whether or not it does.

**Expiry metadata exists but the library does not expose it.** `SavedTokens`
carries no expiry field; the expiry lives inside the JWT payload, which any
holder can read without a network call. Nothing in `@anylist-napi` reads it.

**Refresh credentials exist**: the refresh token is a full second credential,
usable on its own (§6).

**`getTokens()` is stable and side-effect free — Evidence.** Called twice in a
row it returns identical material, and a full read + create + verify + delete
cycle left `accessToken`, `refreshToken`, and `userId` all unchanged.

---

## 5. `fromTokens` findings

**API — Evidence.** `static fromTokens(tokens: SavedTokens): AnyListClient`.

Note the return type: **synchronous, not a Promise.** It constructs the client
and returns. Measured at **3.8 ms**, versus 345–400 ms for `login()`.

That speed is the tell: `fromTokens` performs **no network call and no
validation**. It copies the four fields into the client's auth state, generates
a *new* `client_identifier`, and returns. A restored client holding entirely
invalid material looks identical to a good one until the first request.

**A restored client is fully functional — Evidence.** Experiment 02 runs in a
separate process that deliberately never imports the credential loader, with
`ANYLIST_EMAIL` and `ANYLIST_PASSWORD` both unset in its environment:

| Operation | Result | Latency |
|---|---|---|
| `getRecipes()` | 13 recipes | 209 ms |
| `createRecipe(...)` | id `30d740e7…` | 66 ms |
| `getRecipeById(id)` | id matched | 85 ms |
| `deleteRecipe(id)` | reported success (see §13) | — |

**The password is avoided entirely after restoration.** Read, write, and
verification all succeeded on token material alone. This is the finding the
whole architecture rests on.

**Concurrency — Evidence.** Four clients restored from the *same* stored blob,
running concurrently in one process, all succeeded (221 ms wall clock) and none
mutated the shared material. That is the exact shape of N stateless invocations
reading one stored secret.

---

## 6. Expiry and refresh findings

**Auto-refresh is on by default and is transparent — Evidence.** Both
`login()` and `from_tokens()` set `auto_refresh_enabled: true`. On a 401 the
client refreshes against `https://www.anylist.com/auth/token/refresh` and
replays the original request once.

Waiting out a one-hour access token was not practical inside this session, so
experiment 03 invalidates the JWT signature instead, which produces the same 401
and drives the same code path. Results:

| Scenario | Outcome |
|---|---|
| Dead access token, live refresh token | **Succeeded**, 379 ms, 13 recipes. Fully transparent. |
| After that refresh | Access token changed (`ea4ee428…` → `35bfc4b9…`) |
| Refresh token after that refresh | **Unchanged** (`20ca890f…` before and after) |
| Dead access token **and** dead refresh token | Failed |
| Structurally invalid tokens | Failed, identically |

**The refresh token does not rotate.** This is the single most consequential
finding for deployment. The server returns the same refresh token it was given,
so:

- stored session material does not go stale after use;
- concurrent invocations cannot invalidate each other by refreshing;
- there is no write-back-or-lose-the-session hazard;
- **re-persisting refreshed tokens is an optimisation, not a requirement.**

Re-persisting the refreshed *access* token saves one round trip on the next
invocation. Failing to do so costs a refresh, not a session.

**The error when session material expires — Evidence.** Both unrecoverable
cases produce the same message:

```
Authentication failed: Token refresh failed with status: 401 Unauthorized,
body: <html><title>401: Unauthorized</title><body>401: Unauthorized</body></html>
```

Note that an expired session and structurally invalid tokens are
**indistinguishable** at this boundary — same message, same `code:
"GenericFailure"`. Anything that needs to tell "reconnect" from "corrupt stored
blob" apart must decide it itself, by reading the `exp` claim before use.

**Password login is required again only when the refresh token dies.** On the
evidence, that is at most 730 days after issue, and possibly sooner for reasons
listed in §16.

**Unknown:** whether AnyList invalidates refresh tokens early — on password
change, on explicit sign-out elsewhere, on inactivity, or by `jti` revocation.
Establishing the 730-day figure empirically would take 730 days; the claim value
is evidence, the server honouring it is inference.

**Not exposed by NAPI.** The Rust crate offers `refresh_tokens()`,
`on_auth_event()`, `disable_auto_refresh()`, `user_id()`, `is_premium_user()`,
and `set_client_identifier()`. **None of these are bound in
`@anylist-napi@1.1.1`.** So we cannot proactively refresh before expiry, cannot
observe that a refresh happened, and cannot pin a stable client identifier. The
only refresh trigger available to us is "make a request and let it 401".

---

## 7. Deployment implications

**Stateless functions.** Every invocation is a cold, empty process. There is no
in-memory session to reuse and no safe place to cache one. The choice is
per-invocation `login()` (today) or per-invocation `fromTokens()` from durable
storage.

**Measured cost of the current approach:** 345–400 ms and one password
transmission, on every single import. `fromTokens()` replaces that with 3.8 ms
and no password. On a request that already takes tens of seconds this is not a
latency story — it is a **credential-exposure** story. The password moves from
"transmitted on every import, forever" to "transmitted once, at connect".

**Session reuse across invocations is safe.** Evidence: no rotation (§6), four
concurrent restores non-interfering (§5), reads and writes side-effect free on
token material (§4). No locking, leasing, or coordination is required. This is
unusual and worth stating plainly — it is what makes the recommended
architecture simple.

**Encrypted server-side storage** is the natural home for a `SavedTokens` blob.
It is small (≈730 bytes of JSON), written rarely, and read on every invocation.
Note the shape is a near-exact match for the durable store Wave 1 must choose
anyway for `Idempotency-Key` (ADR-012) — one decision, two consumers.

**Native binary on Vercel.** `@anylist-napi` ships a prebuilt
`linux-x64-gnu` binary, so the Node runtime is fine. It **cannot** run on the
Edge runtime, and it cannot run on iOS at all (§10). Any AnyList call is
therefore pinned to a Node serverless function.

**Backend-held password becomes optional** (§8), which is the point of all of
this.

---

## 8. Possible production architectures

### A. Backend-held password (today)

`ANYLIST_EMAIL` + `ANYLIST_PASSWORD` in the backend environment; full login per
request.

*For:* implemented, proven, zero new machinery, no storage dependency.
*Against:* the backend holds a reusable plaintext password indefinitely; it is
transmitted on every import; it cannot be scoped, rotated per-user, or revoked
without a password change; multi-user is impossible without storing many
passwords.

### B. Backend-held session, password used once *(recommended)*

A one-time connect operation takes the password, calls `login()`, stores the
resulting `SavedTokens` encrypted, and **discards the password without writing
it anywhere**. Every import restores with `fromTokens()`.

*For:* no password at rest; ~340 ms saved per import; works unchanged under
concurrency; extends to multi-user by keying storage on account; disconnect is a
delete.
*Against:* the stored blob is itself a long-lived credential (§11); requires the
durable store and a real encryption key; needs a connect path that today does not
exist.

### C. Device-held session in the iOS Keychain

The device holds `SavedTokens` and sends them to the backend per request.

*For:* nothing persistent at rest on the server.
*Against:* the token crosses the network on **every** import instead of once;
the backend still handles it in cleartext in memory; it puts AnyList credentials
in the app, contradicting **ADR-004**; and it makes a lost device a lost AnyList
session. Strictly worse than B on exposure surface.

### D. Device-side AnyList protocol in Swift

The app talks to AnyList directly, backend never sees credentials.

*For:* the only design where the backend holds nothing.
*Against:* requires reimplementing the protobuf protocol in Swift — a second
unofficial AnyList client to maintain, breaking in the same ways as the first
(§14). Directly contradicts ADR-004 and ADR-005. Every protocol fix becomes an
App Store release. See §10.

---

## 9. Recommended architecture

**Adopt B.** Concretely:

```
connect (once per account)
  password → login() → getTokens() → encrypt → durable store
  password discarded, never written

import (every request)
  durable store → decrypt → fromTokens() → createRecipe → getRecipeById
  password never present in the process

reconnect (rare)
  a 401 from refresh → surface "reconnect AnyList" → connect again
```

Why B over the others, in one line each: A keeps a permanent plaintext password
we do not need; C moves the same secret onto a device *and* the wire without
removing it from the backend; D asks us to maintain two unofficial protocol
implementations.

Four properties of the protocol make B unusually cheap, all evidenced above:
restore is synchronous and free (3.8 ms), refresh is automatic, refresh tokens
do not rotate, and concurrent restores do not interfere. The usual costs of
session storage — leasing, rotation races, write-back on every use — simply do
not apply here.

**Design notes for whoever implements it** (not decisions, and not to be built
during this assignment):

1. **Read `exp` before restoring.** The claim is readable offline. A blob whose
   refresh token has expired should produce "reconnect", not a failed import.
   This is the only way to distinguish expiry from corruption (§6).
2. **Store `userId` alongside the blob** so an account switch is detectable.
3. **Do not write back on every refresh.** No rotation means no need. Write back
   opportunistically at most.
4. **Keep `ANYLIST_PASSWORD` support as a fallback** until connect exists, or
   the CLI loses its only auth path.
5. **Encryption key and ciphertext must not share a store.**

### STOP CONDITION — contract changes this requires

Per ADR-008, these are surfaced, **not implemented**:

1. **`contracts.md` § Environment** is a frozen contract and lists
   `ANYLIST_EMAIL, ANYLIST_PASSWORD` as *the* AnyList credentials. B introduces
   stored session material and makes the password connect-time only. The
   environment table must change.
2. **A connect/disconnect operation does not exist in any contract.** B needs
   one, and it is the first endpoint that would accept an end-user's
   third-party password — which interacts with the unresolved consumer-auth
   question in `contracts.md` § Authentication scope and ADR-014.
3. **A new error condition** — "AnyList session expired, reconnect required" —
   is not representable in the frozen error table. It is not
   `Recipe import failed`: it is actionable by the user and must not read as a
   transient failure. Adding it changes the error-classification contract.
4. **ADR-012's storage decision** should account for a second consumer. Choosing
   an idempotency store without knowing it will also hold session blobs risks
   choosing twice.

---

## 10. Keychain and device implications

**Is local-device authentication practical? No, not without a rewrite.**

The integration is a **Rust crate compiled to a Node native addon**. It is
distributed as prebuilt binaries for macOS, Windows, and Linux only. There is no
iOS target, and NAPI addons do not run on iOS regardless. **Evidence:** the
package's `napi.targets` list and its `optionalDependencies`.

The *protocol* underneath is ordinary HTTPS with protobuf bodies — nothing
prevents a Swift implementation in principle, and experiment 04 shows a
hand-written client can talk to it. But that is option D: a second unofficial
implementation, maintained separately, shipping fixes at App Store cadence, and
contradicting ADR-004 and ADR-005.

**So backend involvement is required for the AnyList call itself.** That is a
protocol-and-packaging fact, not a preference.

The desired flow still works, with the session on the server rather than the
device:

```
Connect AnyList once  →  password to the backend over TLS, used once
                      →  SavedTokens encrypted server-side
                      →  imports need no password re-entry for up to 730 days
```

The Keychain is still useful — for *our* API credential, whatever replaces the
static bearer token (ADR-014). It should not hold AnyList session material,
because the device has nothing it can do with it except forward it.

---

## 11. Credential exposure assessment

**Can the raw AnyList password stay off our backend? Yes, after initial
connect — Evidence.** Experiment 02 performed a full read, write, and
verification in a process with no password in its environment.

The honest comparison:

| | Backend password (A) | Backend session (B) |
|---|---|---|
| What is stored | Reusable password | 730-day bearer credential |
| Grants | Full AnyList account | Full AnyList account |
| Password-reuse risk elsewhere | **Yes** | No |
| Revocable without a password change | No | **Unknown** (§16) |
| Transmitted per import | Every time | Never |
| Readable if storage leaks | Password | Session, until it expires |

**Storing session material is not meaningfully smaller in blast radius than
storing the password.** The token is a bearer credential for the entire account:
lists, items, recipes, meal plans, favourites, store configuration, and
iCalendar sync. Anyone holding it can do everything our integration can do, for
up to two years, without the password.

What B genuinely removes is (i) password reuse against the user's *other*
accounts, and (ii) repeated transmission. Both are real. Neither makes the blob
safe to treat casually.

**Encryption expectations.** Authenticated encryption (AES-256-GCM or
equivalent) with a key held in a secret manager, separate from the ciphertext
store. Rotatable without re-collecting passwords. Ciphertext should never appear
in logs, traces, or error payloads.

**Logging risks.**

- Our adapter is already correct: `AnyListError` carries fixed strings, never
  attaches the provider error, and reads only a numeric status code. That
  discipline must extend to any code that touches `getTokens()` — a
  `console.log(client.getTokens())` would print a two-year credential.
- **The native library writes to stderr on failed login** (§3), outside our
  control. On Vercel that lands in the platform log. Mitigation: assume it, do
  not rely on stderr being clean, and treat a failed AnyList login as a
  log-noise event.
- Redaction scaffolding that already exists and is tested:
  `experiments/lib/redact.ts`.

**Should tokens ever be sent to the native app? No.** Nothing on the device can
use them (§10), so sending them adds exposure and buys nothing. This is
consistent with ADR-004.

---

## 12. Logout, disconnect, and account switching

**There is no revocation API.** The crate exposes no logout, no sign-out, and no
token-invalidation call, and neither does NAPI. **Evidence:** the full method
list in `anylist_rs-0.4.0/src/client.rs` and `index.d.ts`.

Consequences, stated plainly:

| Operation | What it can actually mean |
|---|---|
| **Logout / disconnect** | Delete our stored blob. **Local only.** The refresh token stays valid server-side. |
| **Account switching** | Replace the blob. `userId` distinguishes accounts; store it to detect a switch. |
| **Session revocation** | **Not available to us.** Best available advice to a user: change the AnyList password — and whether that invalidates outstanding refresh tokens is **unknown** (§16). |
| **Invalid credentials** | 401 at login, thrown as `Authentication failed: Login failed with status: 401` |
| **Expired session** | 401 from refresh — indistinguishable from a corrupt blob (§6) |
| **Reconnect** | Password login again, replacing the blob. Old sessions are **not** displaced: logins are additive (§3). |

That last row deserves emphasis. Because a second login does not invalidate the
first, repeated reconnects accumulate live sessions server-side. Nothing we can
call cleans them up.

---

## 13. Mapping and export risks

### `deleteRecipe()` does not delete — Evidence

It returns success and the recipe remains. Confirmed across repeated calls and
minutes apart, so this is not eventual consistency.

Experiment 04 tested five payload shapes against
`data/user-recipe-data/update` with handler `remove-recipe`:

| Payload | HTTP | Deleted? |
|---|---|---|
| `recipeIds` only (what the library sends) | 200 | no |
| `recipe.identifier` only | 200 | no |
| `recipe.identifier` + `recipeIds` | 200 | no |
| `recipeDataId` + `recipe.identifier` + `recipeIds` | 200 | no |
| Reference JS client's exact shape: `recipeDataId` + full timestamped recipe | 200 | no |

Every request returned **200 with no effect**. Since even the shape used by the
mature `anylist@0.8.6` JavaScript client fails, this is **inference**: the
failure is server-side or API-version-related, not a NAPI encoding bug.

**Consequence for the product:** a recipe we create cannot be programmatically
removed. A duplicate export cannot be undone by us — only by the user, in the
AnyList app. That is a stronger statement than ADR-012's honest limits currently
make, and it should be recorded there.

### `prepTime` / `cookTime` persist correctly — the documented bug did not reproduce

**Evidence.** `createRecipe` with `prepTime: 15, cookTime: 40`, read back with
`getRecipeById`:

```
prepTime  sent 15  stored 15
cookTime  sent 40  stored 40
zeroPersistenceReproduced: false
```

The same holds through `updateRecipe`. `CLAUDE.md`, `architecture.md` ("Known
gaps" #4), and ADR-002 all record these fields persisting as `0`, and the
note-based workaround in `src/anylist/mapping.ts` exists because of it.

**This is a finding, not a licence to change the mapping.** Two things are
genuinely unknown: what the original observation was made against (the migration
from `anylist@0.8.6` may be relevant), and whether some *other* value or
combination triggers it. Recommendation: keep the note workaround, correct the
documentation to describe what is currently reproducible, and treat removal of
the workaround as a separate, approved change. Note the workaround is
information-preserving and low-cost — the argument for removing it is tidiness,
not correctness.

### Fidelity of the current mapping — Evidence

Everything the adapter sends survived a round trip byte-identical:

| Field | Result |
|---|---|
| `name`, `note`, `sourceName`, `sourceUrl`, `servings`, `rating`, `nutritionalInfo` | preserved |
| `prepTime`, `cookTime` | preserved (see above) |
| ingredients (5, with quantity and note) | 1:1, identical |
| 426-character ingredient name | preserved in full |
| preparation steps | identical, order preserved |
| en dash `–`, emoji 🔪 🍲, non-ASCII | preserved |

### Fields AnyList cannot represent, or that we lose

- **`rawText` per ingredient.** The adapter drops it — but `PBIngredient` has a
  `rawIngredient` field, and `anylist_rs::Ingredient` supports it. It is
  **`@anylist-napi`'s `IngredientInput` that omits it** (`name`, `quantity`,
  `note` only). So this loss is a binding gap, not an AnyList limitation, and it
  is fixable upstream. Worth recording in the contract as such.
- **`confidence` and `warnings`.** Ours; deliberately never exported (ADR-001).
- **Time *ranges*.** AnyList stores one integer. The adapter flattens to the
  lower bound and preserves the range in the note. Correct and unchanged.
- **`unit` as a distinct field.** AnyList has one `quantity` string. The adapter
  joins them. Lossy but unavoidable.

### NAPI quirks that need contract documentation

1. **`getRecipeById` is not a targeted read.** It calls `get_recipes()`, which
   POSTs `data/user-data/get` and decodes the **entire user data payload** —
   every list, item, setting, meal-plan event, and recipe — then filters client
   side. The comment in `src/anylist/client.ts` saying it "never lists the whole
   collection" is factually wrong, and the cost of verification grows with the
   size of the user's whole account, not their recipe count. Measured 85–246 ms
   on a 13-recipe account.
2. **`getRecipeById` throws rather than returning null.** The crate returns
   `NotFound`. So `AnyListClientLike`'s `| null` branch is dead: a missing
   recipe surfaces as `VERIFY_UNREADABLE`, never `VERIFY_MISSING`. The types are
   structurally compatible, so this is a correctness-of-intent issue, not a bug.
3. **Recipe ids are client-generated** (§1). `save-recipe` is an upsert keyed on
   `identifier` — **inference**, but well supported: `updateRecipe` reaches the
   same handler with an existing id and updates in place. If NAPI exposed id
   selection on create, an interrupted export could be safely retried with the
   same identifier, which would materially strengthen ADR-012. It does not
   expose it today.
4. **`updateRecipe` cannot change the name** — documented upstream, confirmed by
   its use of `RecipeBuilder::from(&existing)`.
5. **`uploadPhoto` has no auto-refresh.** `post_multipart_form` returns
   `Unauthorized - please refresh tokens and retry` on 401 instead of
   refreshing, because the form type is not cloneable. Unused today; a hazard if
   photo support is ever added.

---

## 14. Unofficial integration risks

| Risk | Assessment |
|---|---|
| **AnyList internal API changes** | The client pins `X-AnyLeaf-API-Version: 3`. AnyList's own clients may already be past it — the `remove-recipe` failure is consistent with that. No deprecation notice will reach us. |
| **Authentication changes** | Auth is a bespoke JWT scheme on a private endpoint. An added device check, captcha, or MFA requirement breaks login with no warning. A 730-day refresh token limits how often we are exposed to that, but does not remove it. |
| **Rate limiting** | None observed: ~30 requests including 4 concurrent, no 429, no throttling. **Absence of evidence only** — limits may exist above this volume, or per-account. |
| **Object schema changes** | Protobuf is tolerant of additions; field renumbering or removal would break decoding. `prost` decode failures surface as `ProtobufError`. |
| **Client blocking** | A per-request random `client_identifier` (never a stable one, since NAPI does not expose `set_client_identifier`) makes our traffic look like an unbounded fleet of new devices. That is a plausible anti-abuse signal. Worth noting as a risk **created by the binding's omission**. |
| **Package abandonment** | **Highest-likelihood risk.** One maintainer, one published version (1.1.1), no releases since. `anylist_rs` 0.4.0 likewise. |
| **Native binary compatibility** | Prebuilt, unauditable by npm. No source build fallback without a Rust toolchain. Works on Vercel Node; never on Edge or iOS. |
| **Policy / terms** | Unofficial use of a private API. Not evaluated here; see §15. |

**Contingency.** The migration from `anylist@0.8.6` to `@anylist-napi` touched
only `src/anylist/` and its tests (ADR-002) — that is the measured cost of
swapping the library, and it is low. Concretely: `anylist@0.8.6` remains a
working fallback for lists and recipes; experiment 04 demonstrates that direct
protocol calls are feasible if it comes to that; and vendoring the crate is
possible since both it and the binding are MIT-licensed. The adapter boundary is
doing its job. The risk to plan against is not "the library breaks" — it is
"the library breaks and nobody upstream fixes it".

---

## 15. App Store and policy considerations

Stated as considerations. These are not legal conclusions, and none should be
relied on without review by someone qualified.

**Asking users for third-party credentials.** An app that collects a user's
AnyList email and password to drive an unofficial API is a pattern reviewers
scrutinise. Architecture B reduces but does not remove this: the password is
still collected once, in our UI, and sent to our server. Nothing about session
storage changes the fact that we ask.

**Reliance on an unofficial integration.** The product promise in ADR-006 —
"save recipes directly to AnyList" — depends on an API with no contract, no
support, and no stability guarantee. If it breaks, the app's core function
breaks, in a way no update we ship can fix.

**Terms of service.** AnyList's terms have not been reviewed as part of this
assignment. Whether automated access is permitted is **unknown** and should be
read before distribution rather than after.

**Partnership contact.** Direct contact with AnyList is worth considering before
broad distribution rather than in response to a problem. The realistic outcomes
are a sanctioned path, a clear no, or no reply — and knowing which one is worth
more than assuming. Note the honest asymmetry: for a private single-user tool
this matters little; the moment it is distributed, it matters a great deal.

---

## 16. Unresolved questions

**Auth and session**

1. Does AnyList revoke refresh tokens on password change? **Untested** — it
   would require changing the account password.
2. Are refresh tokens ever invalidated before their 730-day `exp`? Inactivity,
   `jti` revocation, and server-side rotation are all possible and unobservable
   from here.
3. Is there a session limit? Logins are additive; unknown whether an account
   accumulates sessions without bound.
4. Does the fractional `iat`/`exp` encoding cause problems for any consumer?
5. Is `X-AnyLeaf-Client-Identifier` used for anything — device listing,
   rate limiting, anti-abuse?

**Behaviour**

6. Why does `remove-recipe` return 200 and do nothing? API version, a premium
   gate, or a changed handler contract — not distinguished.
7. What did the original `prepTime`/`cookTime` = 0 observation actually
   reproduce against? It does not reproduce now.
8. Do rate limits exist above the ~30-request volume tested?
9. Do duplicate recipe names, or a large recipe library, change any behaviour?
   Not tested — every write is permanent (§13), which raised the cost of
   volume testing.

**Product**

10. Whether an "AnyList session expired" state should be a distinct API error,
    and what the iOS client does with it.
11. Whether multi-user is in scope, which decides whether session storage is
    keyed per account from day one.

---

## 17. Free-account behaviour

**No premium requirement was observed — Evidence.**

- `getTokens().isPremiumUser` is `false` on the test account.
- On that account: `createRecipe` succeeded, `updateRecipe` succeeded,
  `getRecipes` returned 13, and `getRecipeById` verified.
- `is_premium_user` is carried through `SavedTokens` and exposed by
  `AnyListClient::is_premium_user()` in the crate — **which NAPI does not
  bind**. It is readable from `getTokens()` regardless.
- **No premium check exists anywhere in the crate.** Grepping the source finds
  the flag stored and returned, never branched on.

**Inference:** the flag is informational, passed through from the login
response for the client's own use. Any premium enforcement would be server-side.
Nothing observed suggests recipe creation is gated.

**Do not assume premium is required.** The evidence says it is not, for recipe
create, read, and update on a free account.

---

## 18. Recommended ADR changes

All proposed. None applied. ADR-008 governs.

| # | Change | Why |
|---|---|---|
| 1 | **New ADR — session-based AnyList authentication** | Records architecture B, the password-at-connect-only rule, and the four protocol properties that make it cheap. |
| 2 | **Amend ADR-012** | Two additions: `deleteRecipe` does not work, so a duplicate cannot be undone programmatically; and recipe ids are client-generated, which is a real path to idempotent writes if NAPI ever exposes it. |
| 3 | **Amend ADR-014** | Consumer auth and AnyList connect are now coupled: the endpoint that accepts a user's AnyList password is the same endpoint that needs real user authentication. |
| 4 | **Correct `CLAUDE.md` "Known Issues"** | The `prepTime`/`cookTime` zero-persistence claim does not reproduce (§13). Add: `deleteRecipe` silently no-ops. |
| 5 | **Correct `architecture.md` "Known gaps" #4** | Same correction. |
| 6 | **Correct the "server-assigned id" language** wherever it appears | Ids are client-generated (§1). |
| 7 | **Amend `contracts.md` § Current limits** | Verification reads the entire user-data payload, not one recipe. |
| 8 | **Contract changes in §9** | Environment table, connect/disconnect operation, and a session-expired error condition. |

### One production comment is factually wrong

`src/anylist/client.ts`, on `verifyPersisted`:

```
 * Confirms the recipe exists server-side by reading back the server-assigned id.
 * Targeted: it never lists the whole collection and never writes anything.
```

Both sentences in the second line are half wrong: the id is not server-assigned,
and `getRecipeById` fetches the entire user-data payload. "Never writes
anything" is correct.

`src/anylist/**` is read-only under this assignment, so **this has not been
changed.** It is a one-comment fix and needs oversight approval.
