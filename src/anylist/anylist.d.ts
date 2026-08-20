/**
 * Minimal ambient declaration for the untyped CommonJS `anylist` package
 * (v0.8.6 ships no .d.ts and no @types package exists).
 *
 * Deliberately narrow: it declares only the surface this adapter uses, so
 * AnyList internals cannot leak into the rest of the codebase.
 */
declare module "anylist" {
  interface AnyListOptions {
    email: string;
    password: string;
    /** null disables reading and writing the on-disk credentials cache. */
    credentialsFile?: string | null;
  }

  interface AnyListRecipeHandle {
    identifier: string;
    save(): Promise<void>;
  }

  class AnyList {
    constructor(options: AnyListOptions);
    login(connectWebSocket?: boolean): Promise<void>;
    createRecipe(recipe: object): Promise<AnyListRecipeHandle>;
    teardown(): void;
  }

  export = AnyList;
}
