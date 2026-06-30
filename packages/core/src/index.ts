/**
 * @domflax/core — public API barrel.
 *
 * The type contract (`./types`) is the single source of truth for the whole monorepo; the runtime
 * modules below are the dependency-free reference implementations of the IR, the trusted applier,
 * the pass manager, and the pure pipeline.
 */

// Type contract (pure types — zero runtime).
export type * from './types';

// Runtime: IR builders + traversal.
export * from './builders';

// Runtime: the trusted applier.
export * from './ops';

// Runtime: pass manager + match/rewrite contexts.
export * from './pass-manager';

// Runtime: the pure single-file pipeline.
export * from './pipeline';

// Runtime: the shared reverse-emit step (computed → className).
export * from './reverse-emit';
