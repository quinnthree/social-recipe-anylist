/**
 * Places where the production contract could not be turned into a test as
 * written, and what happened to each.
 *
 * The QA brief says to surface an inconsistent or untestable contract rather
 * than rewrite it. This is that list, in code, so it can be asserted, counted,
 * and grepped — and so resolving one is a deliberate edit rather than a quiet
 * assumption in a test.
 *
 * Updated 2026-08-21 against the approved production contract. Six of the eight
 * original entries are resolved; two remain open and three are new.
 */

export interface ContractGap {
  id: string;
  /** The clause that is ambiguous, and what is missing. */
  question: string;
  /** The test that cannot be written until this is resolved. */
  blocks: string;
  severity: "blocks-ios-client" | "blocks-backend" | "documentation";
  /** Set when the approved contract settled it. */
  resolved: boolean;
  /** How it was settled, or null while still open. */
  resolution: string | null;
}

export const UNRESOLVED_CONTRACT_QUESTIONS: readonly ContractGap[] = [
  // ---------------------------------------------------------------- resolved
  {
    id: "QA-011",
    question:
      'The IN_PROGRESS replay ("Return in-progress") and the AMBIGUOUS replay ("Surface for ' +
      'human or client decision") were given no status code and no error string.',
    blocks: "Asserting the response for a replayed IN_PROGRESS or AMBIGUOUS key.",
    severity: "blocks-ios-client",
    resolved: true,
    resolution:
      "409 Export already in progress and 409 Export outcome unknown. All five states now " +
      "have a defined response; asserted in idempotency-contract.test.ts.",
  },
  {
    id: "QA-012",
    question:
      "POST /api/imports had no 500 error string, inheriting Part 1's \"Recipe import failed\" — " +
      "an operation it does not perform.",
    blocks: "Asserting the 500 body for POST /api/imports.",
    severity: "blocks-ios-client",
    resolved: true,
    resolution:
      'The approved error table assigns "Recipe import failed" to the import routes and ' +
      '"Recipe export failed" to the export route.',
  },
  {
    id: "QA-014",
    question:
      "409 was defined on 'a different request body' with no comparison basis, so two clients " +
      "serialising the same recipe differently would conflict spuriously.",
    blocks: "Asserting that a semantically identical body does not conflict.",
    severity: "blocks-backend",
    resolved: true,
    resolution:
      "ADR-018: validate → normalise → deterministically serialise → SHA-256. Raw bytes are " +
      "never compared. Asserted by runFingerprintConformance.",
  },
  {
    id: "QA-015",
    question:
      "Idempotency-Key was 'max 255 chars' with no stated behaviour for a longer key.",
    blocks: "Asserting the response to an over-length Idempotency-Key.",
    severity: "blocks-backend",
    resolved: true,
    resolution:
      "Length 1–128, required on the export route; anything else is 400 Invalid idempotency key.",
  },
  {
    id: "QA-016",
    question:
      "Whether 'every response carries requestId' covered the shared 401/404 handlers and the " +
      "unversioned POST /api/import was unstated.",
    blocks: "Asserting requestId on a 401, a 404, or any /api/import response.",
    severity: "blocks-backend",
    resolved: true,
    resolution:
      "'Every response — 200, 400, 401, 404, 409, 413, 415, 422, and 500 alike, with no " +
      "exceptions.' X-Request-Id always; requestId wherever an envelope is returned.",
  },
  {
    id: "QA-017",
    question:
      "FAILED_SAFE was 'safe to retry' without saying whether the server retries on replay or " +
      "returns the stored failure.",
    blocks: "Asserting whether a replayed FAILED_SAFE key performs a write.",
    severity: "blocks-backend",
    resolved: true,
    resolution:
      "The server re-claims: FAILED_SAFE → IN_PROGRESS must be an atomic re-claim, then the " +
      "export is retried.",
  },

  // -------------------------------------------------------------------- open
  {
    id: "QA-013",
    question:
      "Whether POST /api/imports returns a server-issued recipe identity is still marked open " +
      "in contracts.md §A, pending a decision on persistence.",
    blocks: "Asserting the full set of keys in a successful /api/imports response.",
    severity: "blocks-ios-client",
    resolved: false,
    resolution: null,
  },
  {
    id: "QA-018",
    question:
      "The export success example returns saved.name, but SaveResult.name is the submitted " +
      "title, not a value read back from AnyList. Since the id is client-generated (ADR-021) " +
      "and read-back only confirms existence, no field in the response reflects what AnyList " +
      "actually stored.",
    blocks: "Asserting that saved.name reflects what AnyList stored.",
    severity: "documentation",
    resolved: false,
    resolution: null,
  },
  {
    id: "QA-021",
    question:
      "A flat 24-hour retention contradicted 'a stale IN_PROGRESS must not automatically become " +
      "retryable; expiry is not evidence of safety'. At the TTL boundary the record would be " +
      "deleted, the key would read as unseen, and a retry would write a second time — becoming " +
      "retryable by ageing, at a coarser granularity.",
    blocks:
      "Asserting what a same-key export does 24 hours after an IN_PROGRESS or AMBIGUOUS " +
      "record was written.",
    severity: "blocks-backend",
    resolved: true,
    resolution:
      "ADR-025 makes retention state-dependent: COMPLETED and FAILED_SAFE keep 24 hours, " +
      "IN_PROGRESS and AMBIGUOUS keep 30 days, and a stale lease transitions the record to " +
      "AMBIGUOUS rather than deleting it. Asserted against the real store in " +
      "idempotency-contract.test.ts.",
  },
  {
    id: "QA-022",
    question:
      "'Every response carries X-Request-Id, with no exceptions' read literally includes " +
      "GET /health, which returns no envelope and is the unauthenticated liveness probe.",
    blocks: "Asserting X-Request-Id on GET /health without guessing.",
    severity: "documentation",
    resolved: true,
    resolution:
      "Implemented literally: an onSend hook sets the header on every response, /health and " +
      "404s included. Asserted in tests/http/current-api.test.ts.",
  },
  {
    id: "QA-026",
    question:
      "The contract says requestId appears in the JSON envelope 'wherever an envelope is " +
      "returned', with no exceptions. The implementation puts it in the envelope only on the " +
      "two production routes: POST /api/import and the not-found handler keep their Part 1 " +
      "bodies byte-for-byte, on the stated grounds that Part 1 is frozen and the CLI depends " +
      "on it. Both still carry the X-Request-Id header. Defensible, and not what the sentence " +
      "says.",
    blocks: "Asserting requestId in the envelope of a POST /api/import or 404 response.",
    severity: "documentation",
    resolved: false,
    resolution: null,
  },
  {
    id: "QA-025",
    question:
      "isUsableRecipe trims the title but applies a bare length check to ingredients and " +
      "instructions, so a recipe whose only instruction is \"   \" counts as usable and reaches " +
      "the AnyList write. Literally conformant with ADR-019 — \"   \" is one instruction — but " +
      "not what 'can a person actually cook from this' means. Same root weakness as QA-023.",
    blocks: "Asserting that a blank-only instruction or ingredient name is rejected.",
    severity: "blocks-backend",
    resolved: false,
    resolution: null,
  },
  {
    id: "QA-023",
    question:
      "Inbound hardening rejects whitespace-only titles, but every other .min(1) string in the " +
      "canonical Recipe has the same weakness: ingredient name and rawText, quantity, unit, " +
      "preparation, and instruction steps all admit \"   \". An ingredient named \"   \" would " +
      "reach the user's AnyList shopping list.",
    blocks: "Asserting whether a whitespace-only ingredient name is rejected inbound.",
    severity: "blocks-backend",
    resolved: false,
    resolution: null,
  },
] as const;

export function gap(id: string): ContractGap {
  const found = UNRESOLVED_CONTRACT_QUESTIONS.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`No contract gap with id "${id}".`);
  return found;
}

export const OPEN_QUESTIONS = UNRESOLVED_CONTRACT_QUESTIONS.filter((entry) => !entry.resolved);
export const RESOLVED_QUESTIONS = UNRESOLVED_CONTRACT_QUESTIONS.filter((entry) => entry.resolved);
