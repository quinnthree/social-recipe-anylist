/**
 * A scripted stand-in for the isolated AnyList child (ADR-023 containment
 * tests). Behaviour is chosen by `CHILD_SCRIPT`, so one real process covers
 * every protocol and failure shape without a file per case.
 *
 * Every "secret" it plants is a fixed, obviously synthetic value. Nothing here
 * is a real cookie, token, or session, and the tests assert that none of it
 * survives the boundary.
 */

import { writeSync } from "node:fs";
import { writeFileSync } from "node:fs";

const script = process.env.CHILD_SCRIPT ?? "success";
const pidFile = process.env.CHILD_PID_FILE;

if (pidFile) writeFileSync(pidFile, String(process.pid));

/** Shaped like the native library's failed-login output. All values fabricated. */
const PLANTED_STDERR =
  "Login failed:\n  Status: 401 Unauthorized\n" +
  '  Headers: {"set-cookie": "PLANTED_SESSION=planted-cookie-value; Path=/; HttpOnly", ' +
  '"set-cookie": "PLANTED_CSRF=planted-cookie-value", ' +
  '"authorization": "Bearer planted-bearer-token-value-long-enough", ' +
  '"cookie": "PLANTED=planted-cookie-value"}\n' +
  "  Body: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwbGFudGVkIn0.cGxhbnRlZC1zaWduYXR1cmU\n";

/** Read and discard stdin so the parent's write never blocks. */
async function drainStdin() {
  for await (const _chunk of process.stdin) void _chunk;
}

await drainStdin();

const ok = () => JSON.stringify({ ok: true, identifier: "child-identifier" }) + "\n";

switch (script) {
  case "success":
    process.stdout.write(ok());
    break;

  case "failure":
    process.stdout.write(
      JSON.stringify({ ok: false, code: "create_failed", httpStatus: 500 }) + "\n",
    );
    break;

  case "crash":
    process.exit(3);
    break;

  case "hang":
    // Never answers. The parent's backstop must kill and reap it. The timer
    // keeps the event loop alive: an unsettled top-level await alone would make
    // Node exit 13, which is a crash, not a hang.
    setInterval(() => {}, 1000);
    await new Promise(() => {});
    break;

  case "malformed":
    process.stdout.write("this is not json\n");
    break;

  case "bad_schema":
    // Valid JSON, wrong shape: an extra field is a child we do not understand.
    process.stdout.write(
      JSON.stringify({ ok: true, identifier: "x", extra: "unexpected" }) + "\n",
    );
    break;

  case "unknown_code":
    process.stdout.write(JSON.stringify({ ok: false, code: "nope", httpStatus: null }) + "\n");
    break;

  case "multi":
    process.stdout.write(ok());
    process.stdout.write(ok());
    break;

  case "trailing":
    process.stdout.write(ok());
    process.stdout.write("trailing chatter\n");
    break;

  case "oversized":
    // Awaited: `process.exit` discards pending writes to a pipe, so without
    // this the parent would see a truncated stream and diagnose the wrong fault.
    await new Promise((resolve) => process.stdout.write("x".repeat(70 * 1024) + "\n", resolve));
    process.stdout.write(ok());
    break;

  case "leaky":
    // Writes past JavaScript, exactly as `eprintln!` does from Rust.
    writeSync(2, PLANTED_STDERR);
    process.stdout.write(ok());
    break;

  case "stderr_flood":
    // Exceeds the retention ceiling, with planted material at both ends so a
    // truncation bug that kept the wrong slice would still be caught.
    // Planted material goes through the descriptor directly, as native code
    // does. The bulk goes through the stream, because a large synchronous write
    // to a non-blocking pipe raises EAGAIN and would kill the child instead of
    // testing the parent.
    writeSync(2, PLANTED_STDERR);
    process.stderr.write("f".repeat(200 * 1024));
    await new Promise((resolve) => process.stderr.write(PLANTED_STDERR, resolve));
    process.stdout.write(ok());
    break;

  default:
    process.stdout.write(JSON.stringify({ ok: false, code: "bad_request", httpStatus: null }) + "\n");
}

process.exit(script === "crash" ? 3 : 0);
