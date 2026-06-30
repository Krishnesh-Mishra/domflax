/**
 * @domflax/resolver-css — a {@link StyleResolver} backed by the project's own CSS files.
 *
 * Role: parse user-authored stylesheets with postcss, index every selector + declaration block, and
 * answer the resolver contract for plain `class="…"` tokens:
 *
 *   • `resolve(classes)` — FORWARD. Union the declarations of every rule whose selector is a simple
 *     `.class` selector (optionally qualified by state pseudo-classes / a pseudo-element / wrapped in
 *     an `@media`, which become {@link StyleCondition}s) into a normalized, condition-keyed
 *     {@link StyleMap}. The shared {@link normalizer} expands shorthands and canonicalizes values so
 *     resolver + patterns + verify agree byte-for-byte. Equal-specificity single-class rules cascade
 *     by SOURCE order (later wins); BASE is the unconditional must-have block.
 *   • `emit(styles)` — REVERSE. Best-effort map a {@link StyleMap} back to the minimal set of existing
 *     class names whose own declarations are all present in the target. If nothing matches it returns
 *     no classes and `exact:false`; it never throws.
 *   • `selectorUsage(token)` — how a class participates in project selectors (subject / ancestor /
 *     sibling / compound / `:has()` argument / structural pseudo), driving compress safety. Backed by
 *     postcss-selector-parser so combinator and structural-pseudo facts are accurate.
 *   • {@link CustomCSSResolver.complexSelectors} — the list of COMPLEX selectors (anything with a
 *     combinator or a structural pseudo). This feeds domflax's CSS-selector-safety guard.
 *
 * CSS is accepted as raw sources (id + text) and/or as file paths read synchronously from disk, so
 * the resolver is fully unit-testable without touching the filesystem. Malformed CSS never throws —
 * an unparseable stylesheet simply contributes nothing; only genuine input errors (e.g. an
 * unreadable file path) surface as thrown errors.
 */

export { CSS_RESOLVER_ID, CSS_RESOLVER_PROVIDER } from './constants';
export { createCssResolver, CustomCSSResolver } from './resolver';
export type { CssFile, CssResolverOptions } from './types';
