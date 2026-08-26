/**
 * The isolated AnyList child (ADR-023 containment).
 *
 * **This is the only file in production source permitted to load
 * `@anylist-napi/anylist-napi` at runtime.** `tests/architecture/
 * anylist-import-boundary.test.ts` fails CI if any other production file does.
 *
 * It is plain JavaScript because the deployed Vercel runtime has no TypeScript
 * loader, and it is spawned rather than imported — which is precisely why it
 * must be named in the entrypoint's `includeFiles`, since import tracing cannot
 * see it.
 *
 * Why the isolation matters: on a failed login the native library executes four
 * `eprintln!` calls that dump the HTTP status, the full response header map
 * including `set-cookie`, and the body straight to file descriptor 2, below
 * anything JavaScript can intercept. Here that descriptor belongs to a pipe the
 * parent owns, scans, and discards, instead of the platform log.
 *
 * Protocol:
 *   stdin   one JSON line — `{ operation: "save", payload }`. Credentials are
 *           **not** carried here: they are read from the inherited environment,
 *           exactly as before this milestone. The channel exists and is already
 *           the right shape should a future Connect flow need to pass a password
 *           without putting it in argv, where a process listing would show it.
 *   stdout  exactly one JSON line from the closed schema in
 *           `../child-protocol.ts`. Nothing else is ever written.
 *   stderr  whatever the native library decides. Never written to deliberately.
 */

const MAX_REQUEST_BYTES = 512 * 1024;

function respond(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

function fail(code, httpStatus = null) {
  respond({ ok: false, code, httpStatus });
}

/**
 * The only provider-derived value permitted across the boundary. Read
 * defensively: the error is never otherwise inspected, serialised, or attached
 * to anything, because its message and response carry the submitted credentials.
 */
function readStatusCode(error) {
  if (typeof error !== "object" || error === null) return null;

  const response = error.response;
  if (typeof response !== "object" || response === null) return null;

  return typeof response.statusCode === "number" ? response.statusCode : null;
}

async function readRequest() {
  const chunks = [];
  let total = 0;

  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_REQUEST_BYTES) return null;
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

async function main() {
  const request = await readRequest();

  if (
    request === null ||
    typeof request !== "object" ||
    request.operation !== "save" ||
    typeof request.payload !== "object" ||
    request.payload === null
  ) {
    fail("bad_request");
    return;
  }

  const email = process.env.ANYLIST_EMAIL?.trim();
  const password = process.env.ANYLIST_PASSWORD;

  // The parent checks this too, before it ever spawns. Repeated here because
  // the child must not depend on the parent having done so.
  if (!email || !password) {
    fail("missing_credentials");
    return;
  }

  // Loading the native module provably precedes any network call, so a failure
  // here carries the same positive evidence as missing credentials: nothing was
  // attempted, and a retry is safe.
  let AnyListClient;
  try {
    ({ AnyListClient } = await import("@anylist-napi/anylist-napi"));
  } catch {
    fail("login_failed");
    return;
  }

  let client;
  try {
    client = await AnyListClient.login(email, password);
  } catch (error) {
    fail("login_failed", readStatusCode(error));
    return;
  }

  let created;
  try {
    // createRecipe IS the persisted write in this library; there is no save().
    // Its returned id is client-generated, so it is not persistence evidence.
    created = await client.createRecipe(request.payload);
  } catch (error) {
    fail("create_failed", readStatusCode(error));
    return;
  }

  // The id is generated client-side, so createRecipe returning one proves
  // nothing. This read is the only evidence the write landed.
  let stored;
  try {
    stored = await client.getRecipeById(created.id);
  } catch (error) {
    fail("verify_unreadable", readStatusCode(error));
    return;
  }

  if (!stored || stored.id !== created.id) {
    fail("verify_missing");
    return;
  }

  respond({ ok: true, identifier: created.id });
}

try {
  await main();
} catch {
  // Any unrecognised throw. The error is never inspected: reaching this point
  // means the write may already have happened, which the parent treats as
  // ambiguous.
  fail("create_failed");
}

process.exit(0);
