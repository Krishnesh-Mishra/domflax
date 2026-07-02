/**
 * @domflax/core — public API barrel.
 *
 * The type contract (`./types`) is the single source of truth for the whole monorepo; the runtime
 * modules below are the dependency-free reference implementations of the IR, the trusted applier,
 * the pass manager, and the pure pipeline.
 */

// Type contract (pure types — zero runtime).
export type * from './ir/types';

// Runtime: IR builders + traversal.
export * from './ir/builders';

// Runtime: the trusted applier.
export * from './ir/ops';

// Runtime: pass manager + match/rewrite contexts (re-exports ./pass-context's public surface).
export * from './passes/pass-manager';

// Runtime: static flatten classifier (the safety core for the provably-safe gate).
export * from './flatten/flatten-safety';

// Runtime: the pure single-file pipeline.
export * from './passes/pipeline';

// Runtime: the shared reverse-emit step (computed → className).
export * from './compress/reverse-emit';

// Runtime: segment-local static extraction for mixed (cn()/template) class lists.
export * from './compress/segment-compress';

// Runtime: the inline-style ⇄ class converter (static `style` attribute → shorter classes).
export * from './compress/style-to-class';

// Runtime: the provider-uniform minimal-string exact-cover compress engine.
export * from './compress/compress-engine';
