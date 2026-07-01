/**
 * @domflax/patterns — the built-in rewrite pattern library.
 *
 * Patterns are AUTO-DISCOVERED by file convention: any `*.pattern.ts` under a DOMAIN folder in
 * `src/library/` (e.g. `wrapper/`, `flex/`, `grid/`, `fragment/`, `layout/`) that default- or
 * named-exports a `definePattern()`-built Pattern is picked up by `scripts/gen-registry.mjs`, which
 * writes `src/_registry.generated.ts` (a gitignored build artifact, regenerated before
 * build/typecheck/test). Adding a pattern therefore needs no manual edit to this file — just drop in
 * a new `*.pattern.ts`. The pass PHASE is derived from each pattern's `category` first segment, not
 * its folder.
 *
 * This barrel simply re-exports the generated registry: every pattern individually, the assembled
 * {@link builtinPatterns} array (flatten patterns before compress), and that array as the default.
 */

import { builtinPatterns } from './_registry.generated';

export * from './_registry.generated';

export default builtinPatterns;
