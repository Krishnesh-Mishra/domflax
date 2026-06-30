/**
 * @domflax/patterns — the built-in rewrite pattern library.
 *
 * Patterns are AUTO-DISCOVERED by file convention: any `*.pattern.ts` under `src/library/flatten/`
 * or `src/library/compress/` that default- or named-exports a `definePattern()`-built Pattern is picked up by
 * `scripts/gen-registry.mjs`, which writes `src/_registry.generated.ts` (a gitignored build
 * artifact, regenerated before build/typecheck/test). Adding a pattern therefore needs no manual
 * edit to this file — just drop in a new `*.pattern.ts`.
 *
 * This barrel simply re-exports the generated registry: every pattern individually, the assembled
 * {@link builtinPatterns} array (flatten patterns before compress), and that array as the default.
 */

import { builtinPatterns } from './_registry.generated';

export * from './_registry.generated';

export default builtinPatterns;
