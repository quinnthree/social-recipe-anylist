import type { Recipe } from "../recipe/schema.js";
import { toAnyListRecipe } from "./mapping.js";
import { AnyListError, type CreateRecipeOptions, type RecipeSaver, type SaveResult } from "./types.js";

const LOGIN_FAILED = "AnyList login failed. Check ANYLIST_EMAIL and ANYLIST_PASSWORD in .env.";
const SAVE_FAILED = "Failed to save the recipe to AnyList.";
const MISSING_CREDENTIALS =
  "Missing AnyList credentials. Set ANYLIST_EMAIL and ANYLIST_PASSWORD in .env (see .env.example).";
const VERIFY_UNREADABLE =
  "AnyList accepted the save request, but the recipe could not be read back to verify it.";
const VERIFY_MISSING =
  "AnyList accepted the save request, but the recipe could not be verified in the account.";

/** The subset of AnyListClient this adapter drives. */
export interface AnyListClientLike {
  createRecipe(options: CreateRecipeOptions): Promise<{ id: string; name: string }>;
  getRecipeById(recipeId: string): Promise<{ id: string } | null>;
}

/** Connects and authenticates. Login failures surface here. */
export type AnyListConnect = () => Promise<AnyListClientLike>;

export class AnyListRecipeSaver implements RecipeSaver {
  constructor(private readonly connect: AnyListConnect) {}

  /**
   * Builds a saver from ANYLIST_EMAIL / ANYLIST_PASSWORD. The AnyList library is
   * imported lazily so a dry run never loads it or its native binary.
   */
  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): AnyListRecipeSaver {
    const email = env["ANYLIST_EMAIL"]?.trim();
    const password = env["ANYLIST_PASSWORD"];

    if (!email || !password) throw new AnyListError(MISSING_CREDENTIALS);

    return new AnyListRecipeSaver(async () => {
      const { AnyListClient } = await import("@anylist-napi/anylist-napi");
      // Tokens stay in memory for the life of the process. getTokens() is never
      // called, so nothing is persisted to disk.
      return AnyListClient.login(email, password);
    });
  }

  async save(recipe: Recipe): Promise<SaveResult> {
    const client = await this.login();
    const payload = toAnyListRecipe(recipe);

    let created: { id: string; name: string };
    try {
      // createRecipe IS the persisted write in this library; there is no save().
      // Its returned id is client-generated, so it is not persistence evidence.
      created = await client.createRecipe(payload);
    } catch (error) {
      throw new AnyListError(withStatus(SAVE_FAILED, error));
    }

    await verifyPersisted(client, created.id);

    return { name: payload.name, identifier: created.id };
  }

  private async login(): Promise<AnyListClientLike> {
    try {
      return await this.connect();
    } catch (error) {
      throw new AnyListError(withStatus(LOGIN_FAILED, error));
    }
  }
}

/**
 * Confirms the recipe really persisted, by reading it back by id.
 *
 * The id is generated client-side by the AnyList library, so createRecipe()
 * returning one is not proof of persistence — this read is. Note that
 * getRecipeById is targeted only in its API shape: the protocol exposes a
 * single read endpoint (data/user-data/get), so the library fetches the whole
 * user-data blob and filters client-side. It performs no write.
 */
async function verifyPersisted(client: AnyListClientLike, id: string): Promise<void> {
  let stored: { id: string } | null;

  try {
    stored = await client.getRecipeById(id);
  } catch (error) {
    throw new AnyListError(withStatus(VERIFY_UNREADABLE, error));
  }

  if (stored?.id !== id) throw new AnyListError(VERIFY_MISSING);
}

/**
 * Appends an HTTP status when one is reachable as a plain number. Nothing else
 * from the underlying error is read — its message, stack, and any request or
 * response detail can carry the submitted credentials.
 */
function withStatus(message: string, error: unknown): string {
  const status = readStatusCode(error);
  return status === null ? message : `${message} (HTTP ${status})`;
}

function readStatusCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;

  const { response } = error as { response?: unknown };
  if (typeof response !== "object" || response === null) return null;

  const { statusCode } = response as { statusCode?: unknown };
  return typeof statusCode === "number" ? statusCode : null;
}
