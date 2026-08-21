# AnyList session experiments

Research scaffolding for `docs/anylist-auth.md`. Not production code, not
imported by anything in `src/`.

## Safety rules these scripts follow

- **Nothing prints a secret.** Every value that could be credential material
  goes through `lib/redact.ts`, which emits lengths, character classes, and
  12-hex SHA-256 fingerprints — never a substring. `OutputGuard` is a second
  layer: registered secrets are masked on the way to stdout even if something
  tries to print one.
- **Credentials are read, never written.** Point `ANYLIST_ENV_FILE` at an
  existing `.env`; the scripts do not create one.
- **Captured session material stays out of the repository.** The token file
  defaults to `.anylist_credentials`, which `.gitignore` already covers. Prefer
  an absolute path outside the repo.
- **Writes are labelled and minimal.** Anything created is named with the
  `ZZ-AUTH-RESEARCH-PROBE` prefix.

## Running

```sh
export ANYLIST_ENV_FILE=/path/to/.env          # must define ANYLIST_EMAIL + ANYLIST_PASSWORD
export ANYLIST_TOKEN_FILE=/tmp/anylist-tokens.json

npx tsx experiments/01-login-and-tokens.ts     # captures the session
npx tsx experiments/02-restore-in-fresh-process.ts
npx tsx experiments/03-refresh-and-expiry.ts
```

Experiments 02 onward need only the token file. Run them with the credentials
unset to prove the password is not involved:

```sh
env -u ANYLIST_EMAIL -u ANYLIST_PASSWORD npx tsx experiments/02-restore-in-fresh-process.ts
```

## Scripts

| Script | Live account? | Creates a recipe? |
|---|---|---|
| `00-describe-stored-tokens.ts` | no — fully offline | no |
| `01-login-and-tokens.ts` | yes, logs in twice | no |
| `02-restore-in-fresh-process.ts` | yes, token-only | **yes, one** |
| `03-refresh-and-expiry.ts` | yes, token-only | no |
| `04-recipe-deletion-probe.ts` | yes, raw protocol calls | no |
| `05-mapping-fidelity.ts` | yes, token-only | no — updates the existing probe |
| `06-failure-and-concurrency.ts` | yes, one bad login | no |
| `07-create-time-fields.ts` | yes, token-only | **yes, one** |
| `cleanup-probe-recipes.ts` | yes, token-only | no |

## Cleanup does not work

`deleteRecipe()` reports success and deletes nothing — see
`docs/anylist-auth.md` §13, which tests five payload shapes and rules out the
NAPI binding as the cause. **Probe recipes must be deleted by hand in the
AnyList app.** `cleanup-probe-recipes.ts` still runs, and reports exactly what
it failed to remove, with ids and names.

Treat every recipe these scripts create as permanent, and add writes
deliberately.

## Offline tests

`lib/redact.test.ts` and `lib/protobuf.test.ts` run in the normal `npm test`
sweep. They make no network calls and use synthetic values only.
