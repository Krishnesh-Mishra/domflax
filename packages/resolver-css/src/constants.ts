/* ────────────────────────────────────────────────────────────────────────── *
 * Resolver identity + selector classification constants
 * ────────────────────────────────────────────────────────────────────────── */

/** Stable resolver id surfaced on {@link StyleResolver.id}. */
export const CSS_RESOLVER_ID = 'css';

/** Provider tag surfaced on {@link StyleResolver.provider}. */
export const CSS_RESOLVER_PROVIDER = 'custom-css';

/** Version stamp for the index/cascade machinery; bump when its semantics change (cache-busting). */
export const ENGINE_VERSION = 'css-index@1';

/** Structural pseudo-classes — their presence makes a class structurally targeted (review-1 blocker). */
export const STRUCTURAL_PSEUDOS: ReadonlySet<string> = new Set([
  ':nth-child',
  ':nth-last-child',
  ':first-child',
  ':last-child',
  ':only-child',
  ':nth-of-type',
  ':nth-last-of-type',
  ':first-of-type',
  ':last-of-type',
  ':only-of-type',
]);

/** Functional pseudos whose argument is itself a selector list — opaque to forward resolution. */
export const FUNCTIONAL_PSEUDOS: ReadonlySet<string> = new Set([
  ':not',
  ':is',
  ':where',
  ':has',
  ':matches',
]);

/** Legacy single-colon pseudo-ELEMENTS that the parser may not flag via `isPseudoElement`. */
export const LEGACY_PSEUDO_ELEMENTS: ReadonlySet<string> = new Set([
  ':before',
  ':after',
  ':first-line',
  ':first-letter',
]);
