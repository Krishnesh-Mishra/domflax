/**
 * @domflax/cli — worker-pool entry point (FEATURE B).
 *
 * A dedicated, self-contained module so tsup emits it as its OWN bundle (`worker.cjs`/`worker.js`),
 * loadable by `new Worker(...)` both from `packages/cli/dist` and when inlined into `domflax/dist`.
 * Importing it starts the worker loop (a no-op on the main thread).
 */

import { runWorker } from './worker-main';

runWorker();
