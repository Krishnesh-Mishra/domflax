/**
 * @domflax/pattern-kit — the authoring surface for rewrite patterns.
 *
 * Re-exports the four pillars pattern authors compose with:
 *   • {@link definePattern} — validated Pattern factory.
 *   • the matcher vocabulary (`and`/`or`/`not`/`isElement`/`computed`/… ) from `./combinators`.
 *   • the op-draft constructors (`mergeStyle`/`foldInheritedStyles`/`replaceWith`/`removeNode`).
 *   • the shared {@link normalizer} (also consumed by core + verify) from `./normalize`.
 *   • the declarative {@link pattern} authoring sugar from `./pattern`.
 *
 * The auto-test harness lives in the separate `./testing` entry (it imports vitest) so the main
 * authoring surface stays runtime-light and frontend-agnostic.
 */

export * from './define';
export * from './combinators';
export * from './ops';
export * from './normalize';
export * from './pattern';
