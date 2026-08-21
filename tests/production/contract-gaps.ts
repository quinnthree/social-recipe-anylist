/**
 * Places where contracts.md Part 2 cannot be turned into a test as written.
 *
 * The QA brief says to surface an inconsistent or untestable contract rather
 * than rewrite it. This is that list, in code, so it can be asserted, counted,
 * and grepped — and so that resolving one is a deliberate edit rather than a
 * quiet assumption in a test.
 *
 * Every entry blocks a specific assertion. `blocks` names it.
 */

export interface ContractGap {
  id: string;
  /** The clause in contracts.md that is ambiguous, and what is missing. */
  question: string;
  /** The test that cannot be written until this is resolved. */
  blocks: string;
  /** Who has to decide. Everything here needs oversight, none of it needs code. */
  severity: "blocks-ios-client" | "blocks-backend" | "documentation";
}

export const UNRESOLVED_CONTRACT_QUESTIONS: readonly ContractGap[] = [
  {
    id: "QA-011",
    question:
      'The IN_PROGRESS replay ("Return in-progress") and the AMBIGUOUS replay ("Surface for ' +
      'human or client decision") are given no status code and no error string.',
    blocks: "Asserting the response for a replayed IN_PROGRESS or AMBIGUOUS key.",
    severity: "blocks-ios-client",
  },
  {
    id: "QA-012",
    question:
      "POST /api/imports has no 500 error string. It inherits Part 1's rows, whose 500 is " +
      '"Recipe import failed" — an operation this endpoint does not perform. ' +
      '/api/exports/anylist was given its own string; /api/imports was not.',
    blocks: "Asserting the 500 body for POST /api/imports.",
    severity: "blocks-ios-client",
  },
  {
    id: "QA-013",
    question:
      "Whether POST /api/imports returns a server-issued recipe identity is marked open in " +
      "contracts.md, pending a decision on persistence.",
    blocks: "Asserting the full set of keys in a successful /api/imports response.",
    severity: "blocks-ios-client",
  },
  {
    id: "QA-014",
    question:
      "409 Idempotency key conflict is defined as the same key with 'a different request " +
      "body', but the comparison basis is not specified: raw bytes, canonical JSON, or a " +
      "hash of which fields. Two clients serialising the same recipe differently would " +
      "conflict spuriously.",
    blocks: "Asserting that a semantically identical body does not conflict.",
    severity: "blocks-backend",
  },
  {
    id: "QA-015",
    question:
      "Idempotency-Key is 'max 255 chars', with no stated behaviour for a longer key. " +
      "400, truncation, and ignoring the key are all defensible and materially different.",
    blocks: "Asserting the response to an over-length Idempotency-Key.",
    severity: "blocks-backend",
  },
  {
    id: "QA-016",
    question:
      '"Every response, success or failure, carries requestId" sits in Part 2. Whether it ' +
      "also applies to the shared 401 and 404 handlers, and to the unversioned Part 1 " +
      "POST /api/import, is not stated. Part 1 says request IDs are not exposed at all.",
    blocks: "Asserting requestId on a 401, a 404, or any POST /api/import response.",
    severity: "blocks-backend",
  },
  {
    id: "QA-017",
    question:
      "FAILED_SAFE is 'safe to retry', but not whether the server retries automatically on " +
      "a replay of that key or returns the stored failure and leaves the retry to the client.",
    blocks: "Asserting whether a replayed FAILED_SAFE key performs a write.",
    severity: "blocks-backend",
  },
  {
    id: "QA-018",
    question:
      "The export success example returns saved.name. The AnyList adapter's SaveResult.name " +
      "is the submitted title, not a value read back from AnyList, so the field asserts less " +
      "than it appears to.",
    blocks: "Asserting that saved.name reflects what AnyList actually stored.",
    severity: "documentation",
  },
] as const;

export function gap(id: string): ContractGap {
  const found = UNRESOLVED_CONTRACT_QUESTIONS.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`No contract gap with id "${id}".`);
  return found;
}
