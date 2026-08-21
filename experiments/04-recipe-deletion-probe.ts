import { randomUUID } from "node:crypto";

import { AnyListClient } from "@anylist-napi/anylist-napi";

import {
  concat,
  doubleField,
  findField,
  int32Field,
  messageField,
  stringField,
} from "./lib/protobuf.js";
import { OutputGuard } from "./lib/redact.js";
import { PROBE_PREFIX, describeError, guardTokens, readTokens } from "./lib/session.js";

/**
 * Experiment 4 — why `deleteRecipe()` reports success and deletes nothing.
 *
 * The library encodes the removal as `PBRecipeOperation.recipeIds`, with the
 * `recipe` field left empty. AnyList's `save-recipe` handler takes the recipe in
 * `recipe`, so the hypothesis is that `remove-recipe` does too, and that the
 * server is quietly ignoring an operation with nothing in the field it reads.
 *
 * This sends the same operation with `recipe.identifier` populated and checks
 * whether the recipe disappears. It is also the only way to clean up probe
 * recipes the library itself cannot remove.
 *
 * Safety: refuses to touch anything whose name is not a research probe.
 */

const ENDPOINT = "https://www.anylist.com/data/user-recipe-data/update";
const USER_DATA_ENDPOINT = "https://www.anylist.com/data/user-data/get";

/** Same 32-hex shape the library generates for its own client identifier. */
function clientIdentifier(): string {
  return randomUUID().replaceAll("-", "");
}

interface RemoveVariant {
  label: string;
  /** Whether the recipe id goes in `recipe.identifier`, in `recipeIds`, or both. */
  useRecipeField: boolean;
  useRecipeIds: boolean;
  /** The library never sends `recipeDataId`. This is the field it omits. */
  useRecipeDataId?: boolean;
  /** Send a fully-formed recipe with a fresh sync timestamp, not a bare identifier. */
  useFullRecipe?: boolean;
  /** The library always sets operationClass; the reference JS client never does. */
  omitOperationClass?: boolean;
}

function encodeRemoveOperation(
  recipe: { id: string; name: string },
  userId: string,
  variant: RemoveVariant,
  recipeDataId: string | null,
): Uint8Array {
  const recipeId = recipe.id;
  const metadata = concat([
    stringField(1, clientIdentifier()), // operationId
    stringField(2, "remove-recipe"), // handlerId
    stringField(3, userId), // userId
    ...(variant.omitOperationClass === true ? [] : [int32Field(4, 0)]), // operationClass
  ]);

  const parts: Uint8Array[] = [messageField(1, metadata)];

  if (variant.useRecipeDataId === true && recipeDataId !== null) {
    parts.push(stringField(2, recipeDataId)); // PBRecipeOperation.recipeDataId
  }

  // PBRecipe.identifier is field 1 and is the only required field.
  if (variant.useRecipeField) {
    const seconds = Date.now() / 1000;
    const body =
      variant.useFullRecipe === true
        ? concat([
            stringField(1, recipeId),
            doubleField(2, seconds), // timestamp: AnyList resolves conflicts by this
            stringField(3, recipe.name),
            doubleField(14, 1), // scaleFactor
            doubleField(16, seconds), // creationTimestamp
          ])
        : stringField(1, recipeId);

    parts.push(messageField(3, body));
  }
  if (variant.useRecipeIds) parts.push(stringField(9, recipeId));

  return messageField(1, concat(parts)); // PBRecipeOperationList.operations
}

async function postOperation(accessToken: string, body: Uint8Array): Promise<number> {
  // Copied into a plain ArrayBuffer so the Blob types line up under strict TS.
  const bytes = new Uint8Array(new ArrayBuffer(body.length));
  bytes.set(body);

  const form = new FormData();
  form.append("operations", new Blob([bytes]));

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-AnyLeaf-API-Version": "3",
      "X-AnyLeaf-Client-Identifier": clientIdentifier(),
    },
    body: form,
  });

  return response.status;
}

const VARIANTS: readonly RemoveVariant[] = [
  { label: "recipeIds only (what the library sends)", useRecipeField: false, useRecipeIds: true },
  { label: "recipe.identifier only", useRecipeField: true, useRecipeIds: false },
  { label: "recipe.identifier and recipeIds", useRecipeField: true, useRecipeIds: true },
  {
    label: "recipeDataId + recipe.identifier + recipeIds",
    useRecipeField: true,
    useRecipeIds: true,
    useRecipeDataId: true,
  },
  {
    label: "reference-client shape: recipeDataId + full timestamped recipe",
    useRecipeField: true,
    useRecipeIds: true,
    useRecipeDataId: true,
    useFullRecipe: true,
    omitOperationClass: true,
  },
];

/**
 * `recipeDataId` identifies the user's recipe container. The library never sends
 * it, so it is the most likely reason a well-formed operation is accepted and
 * then ignored. Reaching it means decoding two nested fields of the user-data
 * response: PBUserDataResponse.recipeDataResponse (3) -> recipeDataId (9).
 */
async function fetchRecipeDataId(accessToken: string): Promise<string | null> {
  const response = await fetch(USER_DATA_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-AnyLeaf-API-Version": "3",
      "X-AnyLeaf-Client-Identifier": clientIdentifier(),
    },
    body: new FormData(),
  });

  if (!response.ok) return null;

  const body = new Uint8Array(await response.arrayBuffer());
  const recipeData = findField(body, 3);
  if (recipeData === null) return null;

  const id = findField(recipeData, 9);
  return id === null ? null : new TextDecoder().decode(id);
}

async function main(): Promise<void> {
  const guard = new OutputGuard();
  const tokens = readTokens();
  guardTokens(guard, tokens);

  const client = AnyListClient.fromTokens(tokens);

  const recipeDataId = await fetchRecipeDataId(tokens.accessToken);
  guard.register(recipeDataId);
  guard.log("recipe container:", { recipeDataIdPresent: recipeDataId !== null });

  for (const variant of VARIANTS) {
    const before = await client.getRecipes();
    const target = before.find((recipe) => recipe.name.startsWith(PROBE_PREFIX));

    if (target === undefined) {
      guard.log(`no probe recipe left to test "${variant.label}" against`);
      continue;
    }

    try {
      const status = await postOperation(
        tokens.accessToken,
        encodeRemoveOperation(target, tokens.userId, variant, recipeDataId),
      );
      const after = await client.getRecipes();
      const survived = after.some((recipe) => recipe.id === target.id);

      guard.log(`variant: ${variant.label}`, {
        httpStatus: status,
        recipeId: target.id,
        recipeCountBefore: before.length,
        recipeCountAfter: after.length,
        deleted: !survived,
      });
    } catch (error) {
      guard.log(`variant: ${variant.label} FAILED`, describeError(guard, error));
    }
  }
}

main().catch((error: unknown) => {
  const guard = new OutputGuard();
  console.error("experiment failed:", describeError(guard, error));
  process.exitCode = 1;
});
