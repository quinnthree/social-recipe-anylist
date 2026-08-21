/**
 * The Vercel deployment entrypoint. One line on purpose.
 *
 * Vercel finds a Fastify app by checking a fixed, ordered list of locations:
 * `src/app`, `src/index`, `src/server`, then the same three at the project
 * root. **`src/index.ts` is our CLI**, which guards its own execution behind an
 * argv check and therefore never calls `listen()` when imported — so if Vercel
 * selected it, the deployment would come up with no HTTP server at all.
 *
 * Claiming the first slot removes that ambiguity entirely. It duplicates
 * nothing: importing `./server.js` runs the same entrypoint `npm run server`
 * runs, and that module calls `listen()` at load.
 */
import "./server.js";
