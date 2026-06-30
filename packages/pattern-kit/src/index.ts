/**
 * @domflax/pattern-kit — the authoring surface for rewrite patterns.
 *
 * Re-exports the pillars pattern authors compose with:
 *   • {@link definePattern} — THE declarative pattern factory (definition + co-located tests). The
 *     lower-level validator it compiles down to is intentionally kept private (see `./define`).
 *   • the matcher vocabulary (`and`/`or`/`not`/`isElement`/`computed`/… ) from `./combinators`.
 *   • the op-draft constructors (`mergeStyle`/`foldInheritedStyles`/`replaceWith`/`removeNode`).
 *   • the shared {@link normalizer} (also consumed by core + verify) from `./normalize`.
 *
 * The generic test harness lives in the separate `./testing` entry (it imports vitest) so the main
 * authoring surface stays runtime-light and frontend-agnostic.
 */

export * from './combinators';
export * from './ops';
export * from './normalize';
export * from './pattern';
