/**
 * @domflax/core — the pure applier (the one trusted mutator) — public barrel.
 *
 * {@link applyOps} takes an {@link IRDocument} plus a flat list of {@link RewriteOp}s and returns a
 * NEW, mutated document (the input is left untouched — "pure" in the input-immutability sense). Every
 * op is validated against the safety ceiling and node-local safety floor before it runs; rejected ops
 * are collected into {@link ApplyResult.skipped} with {@link Diagnostic}s rather than throwing.
 * Dependency-free: only the `./types` contract and `./builders` runtime helpers.
 *
 * The implementation is split for size: `./ops/runtime` holds the input-preserving cloning, mutable
 * state, tree helpers, spec materialization, and style merging; `./ops/apply` holds the per-op
 * handlers and the public entry points. This barrel preserves the original public surface.
 */

export type { ApplyOutcome } from './ops/runtime';
export { cloneDocument } from './ops/runtime';
export { applyOps, applyGroups } from './ops/apply';
