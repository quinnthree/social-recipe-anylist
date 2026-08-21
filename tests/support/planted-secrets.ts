/**
 * Values that must never appear in a response or a log line.
 *
 * They are planted, not real: every one is shaped like the credential it stands
 * in for and carries "PLANTED" so a hit in captured output is unambiguous.
 *
 * Kept in its own module so a test can import them without executing
 * log-capture.child.ts, which is a script with side effects.
 */
export const SECRETS = {
  apiKey: "recipe-api-key-PLANTED-8f3a2b",
  anylistPassword: "anylist-password-PLANTED-c4d1e9",
  anylistEmail: "planted-cook@example.com",
  anthropicKey: "sk-ant-api03-PLANTED-deadbeefcafe",
  anylistToken: "anylist-session-token-PLANTED-77aa11",
} as const;
