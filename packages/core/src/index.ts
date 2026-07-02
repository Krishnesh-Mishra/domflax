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

// Runtime: pass manager + match/rewrite contexts (re-exports ./pass-context's public surface).
export * from './pass-manager';

// Runtime: static flatten classifier (the safety core for the provably-safe gate).
export * from './flatten-safety';

// Runtime: the pure single-file pipeline.
export * from './pipeline';

// Runtime: the shared reverse-emit step (computed → className).
export * from './reverse-emit';

// Runtime: segment-local static extraction for mixed (cn()/template) class lists.
export * from './segment-compress';

// Runtime: the provider-uniform minimal-string exact-cover compress engine.
export * from './compress-engine';
