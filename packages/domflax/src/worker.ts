/**
 * `domflax` worker-pool entry.
 *
 * The published `domflax` bin (`cli.cjs`) spins up a parallel worker pool for large batches. The pool
 * loads its worker by path RELATIVE to the running bundle, so the worker must ship alongside `cli.cjs`
 * in `domflax/dist`. This thin entry re-runs the bundled `@domflax/cli` worker (inlined here via tsup's
 * `noExternal`), producing `domflax/dist/worker.cjs` + `worker.js`.
 */
import '@domflax/cli/worker';
