import type { Recipe } from "../recipe/schema.js";
import { toAnyListRecipe } from "./mapping.js";
import { AnyListError, type AnyListRecipe, type RecipeSaver, type SaveResult } from "./types.js";

const LOGIN_FAILED = "AnyList login failed. Check ANYLIST_EMAIL and ANYLIST_PASSWORD in .env.";
const SAVE_FAILED = "Failed to save the recipe to AnyList.";
const MISSING_CREDENTIALS =
  "Missing AnyList credentials. Set ANYLIST_EMAIL and ANYLIST_PASSWORD in .env (see .env.example).";
const VERIFY_UNREADABLE =
  "AnyList accepted the save request, but the account could not be re-read to verify it.";
const VERIFY_MISSING =
  "AnyList accepted the save request, but the recipe could not be verified in the account.";

/** The subset of the anylist package this adapter drives. */
export interface AnyListClientLike {
  login(connectWebSocket?: boolean): Promise<void>;
  createRecipe(recipe: AnyListRecipe): Promise<{
    identifier: string;
    save(): Promise<void>;
  }>;
  getRecipes(refreshCache?: boolean): Promise<Array<{ identifier: string }>>;
  teardown(): void;
}

export type AnyListClientFactory = () => Promise<AnyListClientLike>;

export class AnyListRecipeSaver implements RecipeSaver {
  constructor(private readonly createClient: AnyListClientFactory) {}

  /**
   * Builds a saver from ANYLIST_EMAIL / ANYLIST_PASSWORD. The anylist package
   * is imported lazily so that a dry run never loads or instantiates it.
   */
  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): AnyListRecipeSaver {
    const email = env["ANYLIST_EMAIL"]?.trim();
    const password = env["ANYLIST_PASSWORD"];

    if (!email || !password) throw new AnyListError(MISSING_CREDENTIALS);

    return new AnyListRecipeSaver(async () => {
      const { default: AnyList } = await import("anylist");
      // credentialsFile: null keeps tokens and session state out of the
      // filesystem entirely; .env is the only persisted auth location.
      return new AnyList({ email, password, credentialsFile: null });
    });
  }

  async save(recipe: Recipe): Promise<SaveResult> {
    const client = await this.createClient();

    try {
      return await withAnyListConsoleSuppressed(async () => {
        await login(client);

        const payload = toAnyListRecipe(recipe);

        let identifier: string;
        try {
          const handle = await client.createRecipe(payload);
          await handle.save();
          identifier = handle.identifier;
        } catch (error) {
          throw new AnyListError(withStatus(SAVE_FAILED, error));
        }

        // save() resolving only means the request was accepted. Read the
        // account back from the server and confirm the recipe is really there.
        await verifyPersisted(client, identifier);

        return { name: payload.name, identifier };
      });
    } finally {
      // Runs whether login, mapping, creation, or saving threw.
      client.teardown();
    }
  }
}

/**
 * Confirms a saved recipe exists in the account by forcing a fresh server read
 * and matching on the generated identifier. Never creates a recipe, never
 * retries the save, and never inspects anything but identifiers.
 */
async function verifyPersisted(client: AnyListClientLike, identifier: string): Promise<void> {
  let stored: Array<{ identifier: string }>;

  try {
    // true: bypass the in-memory cache so this is a real server read.
    stored = await client.getRecipes(true);
  } catch (error) {
    throw new AnyListError(withStatus(VERIFY_UNREADABLE, error));
  }

  // Match by identifier, never by name: names are not unique and would make
  // this a duplicate check rather than a verification.
  if (!stored.some((recipe) => recipe.identifier === identifier)) {
    throw new AnyListError(VERIFY_MISSING);
  }
}

async function login(client: AnyListClientLike): Promise<void> {
  try {
    // false: skip the WebSocket, which a one-shot CLI has no use for.
    await client.login(false);
  } catch (error) {
    throw new AnyListError(withStatus(LOGIN_FAILED, error));
  }
}

/**
 * Appends an HTTP status when one is reachable as a plain number. Nothing else
 * from the underlying error is read — its message, stack, request options, and
 * response body can all contain the submitted credentials.
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

/**
 * The anylist package logs progress with console.info (which writes to stdout)
 * and console.error, including endpoint URLs and error stacks. Both are
 * silenced for the duration of the operation and restored afterwards, so
 * stdout carries only our own output and no third-party detail leaks.
 */
async function withAnyListConsoleSuppressed<T>(operation: () => Promise<T>): Promise<T> {
  const original = { info: console.info, error: console.error };
  const noop = (): void => {};

  console.info = noop;
  console.error = noop;

  try {
    return await operation();
  } finally {
    console.info = original.info;
    console.error = original.error;
  }
}
