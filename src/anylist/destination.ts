/**
 * Which AnyList account an export is aimed at.
 *
 * Today there is exactly one: the operator account configured through
 * `ANYLIST_EMAIL` / `ANYLIST_PASSWORD`. So this resolves to a constant, and the
 * only thing it currently buys is that every new idempotency record carries an
 * immutable statement of where its write was sent.
 *
 * That statement is the point. An idempotency key answers "has this logical
 * operation already run?", which is only a safe question if the *destination*
 * is also the same — and a key alone can never say so. When consumer accounts
 * arrive, a record written against one account must not be replayed to another,
 * and a record created before that day still needs to be interpretable. Binding
 * the destination now means the field is already there when the check matters,
 * rather than being retrofitted onto records that never carried it.
 *
 * Three properties are deliberate:
 *
 * - **Server-derived.** It never comes from the request body or from a header.
 *   A client that could name its own destination could aim a replay at someone
 *   else's account.
 * - **Opaque.** `operator:v1` is a label, not an identifier. No AnyList
 *   `userId` is discovered, logged in for, configured, or persisted to produce
 *   it — this milestone deliberately contacts AnyList not at all.
 * - **Immutable per record.** Once written it is never rewritten, so a later
 *   retry can prove what its predecessor targeted.
 *
 * No mismatch is enforced yet, because there is only one destination and a
 * check that can never fail is a check nobody has tested.
 */

/** The single destination in the operator-configured architecture. */
export const OPERATOR_DESTINATION_BINDING = "operator:v1";

/**
 * The destination for an export made by `principal`.
 *
 * The parameter is unused today and is the seam where a per-installation
 * AnyList connection will be looked up. It is present so the call site already
 * reads as "resolve this request's destination" rather than "use the constant",
 * which is the shape the later change needs.
 */
export function resolveDestinationBinding(): string {
  return OPERATOR_DESTINATION_BINDING;
}
