/**
 * @domflax/patterns — flatten pattern: `empty-style-div`.
 *
 * Collapses the most common piece of structural noise of all: a `<div>` whose ONLY role is to wrap
 * a single child while contributing nothing to layout or paint —
 *
 *   <div><Child/></div>            (no styles at all)
 *   <div style="display:block"><Child/></div>   (the default; still a no-op box)
 *
 * Such a div is layout-neutral: it is a plain block box with no own visual style, establishes no
 * box / formatting / stacking context, is not a containing block, and declares no custom properties
 * a descendant might read. Its box is therefore indistinguishable from "not being there", so it can
 * be unwrapped into its sole child.
 *
 * Authored with the declarative {@link definePattern} API. The opacity-barrier + selector-safety
 * guards (ref/handlers/dynamic-children/raw-html/combinator/reparent-impact) are applied
 * automatically for every `flatten/*` pattern; the `where` predicates below add the LAYOUT-neutrality
 * requirements specific to this pattern (no non-block display, no box/formatting/stacking context, no
 * containing block, no custom-property coupling, no structural-pseudo targeting).
 */

import type {
  CssProperty,
  DeepReadonly,
  IRElement,
  IRNode,
  IRNodeId,
  NodeLike,
  NodeMeta,
  StyleMap,
} from '@domflax/core';

import { definePattern, not, type Matcher } from '@domflax/pattern-kit';

/* ───────────────────────── local matcher helpers ───────────────────────── */

/** Narrow a NodeLike to a (readonly) element, or null. */
function asEl(node: NodeLike): DeepReadonly<IRElement> | null {
  const n = node as DeepReadonly<IRNode>;
  return n.kind === 'element' ? (n as DeepReadonly<IRElement>) : null;
}

/** A boolean `meta` flag, lifted into a {@link Matcher}. Mirrors how core's combinators read meta. */
function metaFlag(flag: keyof NodeMeta): Matcher {
  return (node) => Boolean(asEl(node)?.meta[flag]);
}

/** Wrapper establishes an intrinsic/explicit box (sizing) — NOT layout-neutral. */
const establishesBox = metaFlag('establishesBox');
/** Wrapper establishes a formatting context (flex/grid/flow-root/…) — NOT layout-neutral. */
const establishesFormattingContext = metaFlag('establishesFormattingContext');
/** Wrapper establishes a stacking context (transform/opacity<1/z-index/…) — NOT layout-neutral. */
const establishesStackingContext = metaFlag('establishesStackingContext');
/** Wrapper is the containing block for abs/fixed descendants — removing it would reposition them. */
const isContainingBlock = metaFlag('isContainingBlock');
/** Wrapper sets `--*` custom properties a descendant reads (author-var coupling). */
const declaresCustomProperties = metaFlag('declaresCustomProperties');

/**
 * Wrapper is a structural-pseudo target (:first/:last/:only/:nth-child/-of-type). Honours the
 * frontend-set meta flag and the precomputed {@link SelectorIndex}. Unwrapping such a node would
 * change a selector's match-set.
 */
const targetedByStructuralPseudo: Matcher = (node, ctx) => {
  const el = asEl(node);
  if (!el) return false;
  if (el.meta.targetedByStructuralPseudo) return true;
  return ctx.selectors.targetedByStructuralPseudo(el.id as unknown as IRNodeId);
};

const DISPLAY = 'display' as CssProperty;

/**
 * True when the wrapper sets `display` to anything other than the block default in ANY condition.
 * An `inline`/`inline-block`/`flex`/`grid`/`contents`/`none` div is NOT layout-neutral — its box (or
 * lack of one) participates in layout differently from its surviving child.
 */
const hasNonBlockDisplay: Matcher = (node, ctx) => {
  const el = asEl(node);
  if (!el) return false;
  const sm: StyleMap = ctx.computedOf(el as unknown as NodeLike) ?? (el.computed as StyleMap);
  for (const block of sm.blocks.values()) {
    const decl = block.decls.get(DISPLAY);
    if (decl && String(decl.value) !== 'block') return true;
  }
  return false;
};

/* ───────────────────────── the pattern ───────────────────────── */

/**
 * Flatten a layout-neutral, style-free `<div>` wrapper into its sole element child.
 */
export const emptyStyleDiv = definePattern({
  name: 'empty-style-div',
  category: 'flatten/empty-style-div',
  safety: 1,
  doc: {
    title: 'Flatten empty-style div wrapper',
    summary:
      'A layout-neutral div (display:block default, no box/visual styles) that wraps a single ' +
      'child is removed; the child is hoisted into its place.',
    before: '<div><Child/></div>',
    after: '<Child/>',
    safetyRationale:
      'Wrapper is a plain block box that paints nothing, establishes no box/formatting/stacking ' +
      'context, is no containing block, has no custom-property coupling, carries no ' +
      'ref/handlers/dynamic children/raw HTML, and is neither a combinator subject nor a ' +
      'structural-pseudo target; inheritable styles are folded onto the child before removal.',
  },
  match: {
    tag: 'div',
    onlyChild: 'element',
    paintsNothing: true,
    where: [
      not(hasNonBlockDisplay),
      not(establishesBox),
      not(establishesFormattingContext),
      not(establishesStackingContext),
      not(isContainingBlock),
      not(declaresCustomProperties),
      not(targetedByStructuralPseudo),
    ],
  },
  rewrite: { flattenInto: 'child' },
  test: {
    cases: [
      {
        // A layout-neutral, style-free block div is a provably-safe flatten → removed, child hoisted.
        before: '<div><span className="bg-red-200">Hi</span></div>',
        after: '<span className="bg-red-200">Hi</span>',
      },
    ],
    noMatch: [
      // The wrapper paints its own background (own visual style) → not layout-neutral, kept.
      '<div className="bg-blue-500"><span className="bg-red-200">Hi</span></div>',
    ],
  },
});
