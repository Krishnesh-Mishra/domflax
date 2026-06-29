/**
 * @domflax/pattern-kit — the authoring surface for rewrite patterns.
 *
 * Re-exports the four pillars pattern authors compose with:
 *   • {@link definePattern} — validated Pattern factory.
 *   • the matcher vocabulary (`and`/`or`/`not`/`isElement`/`computed`/… ) from `./combinators`.
 *   • the op-draft constructors (`mergeStyle`/`foldInheritedStyles`/`replaceWith`/`removeNode`).
 *   • the shared {@link normalizer} (also consumed by core + verify) from `./normalize`.
 */

export * from './define';
export * from './combinators';
export * from './ops';
export * from './normalize';
