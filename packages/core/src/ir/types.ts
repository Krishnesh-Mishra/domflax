/**
 * @domflax/core — public type contract (barrel).
 *
 * SINGLE SOURCE OF TRUTH for the whole monorepo. Pure type/interface declarations only: ZERO
 * runtime. Every downstream package imports these exact names. The contract is split across three
 * focused modules under `./types/` (kept under the repo's per-file size budget); this barrel
 * re-exports them all so `import … from '@domflax/core'` / `'./types'` is unchanged.
 *
 *   • `./types/ir`          — type utilities, identity primitives, source spans, the StyleMap model,
 *                              NodeMeta, author tokens, the IR node union, document, traversal, specs.
 *   • `./types/resolve-ops` — diagnostics, the style-resolver layer, the selector index, RewriteOp.
 *   • `./types/passes`      — the pattern contract, pass manager + applier, frontends/backends, pipeline.
 *
 * Compiles under: strict, verbatimModuleSyntax, isolatedDeclarations, erasableSyntaxOnly,
 * isolatedModules. No `const enum`: every closed set is a string/number literal UNION; the matching
 * frozen `as const` runtime objects live in sibling runtime modules (constants.ts), not here.
 */

export type * from './types/ir';
export type * from './types/resolve-ops';
export type * from './types/passes';
