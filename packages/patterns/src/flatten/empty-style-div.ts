/**
 * @domflax/patterns — Stage-1 flatten pattern: `empty-style-div`.
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
 * Safety reasoning (why this is sound):
 *   • the wrapper paints nothing of its own (`hasOwnVisualStyle` false across every condition);
 *   • it is a plain `display:block` box — it establishes no box / formatting / stacking context and
 *     is not a containing block, so removing it cannot reflow or reparent-paint its descendants;
 *   • it sets no `--*` custom properties a descendant reads (no author-var coupling);
 *   • it carries no ref / event handlers / dynamic children / raw HTML (hard opacity barriers), so no
 *     JS identity or behaviour is attached to the wrapper element;
 *   • it is neither a combinator subject (`>`/`+`/`~`) nor a structural-pseudo target
 *     (:first/:last/:only/:nth-child …), so unwrapping it cannot change any selector's match-set;
 *   • inheritable declarations on the wrapper (color, font, …) are folded onto the child first, so
 *     inherited values survive the box removal.
 *
 * Realization: as with `flex-center-wrapper`, "replace the wrapper with the child" uses the
 * structural-safe `unwrap` op — for a single-element-child wrapper, unwrapping splices the child into
 * the wrapper's slot and deletes ONLY the wrapper node, preserving the child's `IRNodeId` (D10).
 */

import type {
  CssProperty,
  DeepReadonly,
  IRElement,
  IRNode,
  IRNodeId,
  MatchContext,
  MatchResult,
  NodeLike,
  NodeMeta,
  Pattern,
  RewriteFactory,
  RewriteOpDraft,
  StyleMap,
} from '@domflax/core';

import {
  and,
  definePattern,
  hasDynamicChildren,
  hasEventHandlers,
  hasOwnVisualStyle,
  hasRef,
  hasSingleElementChild,
  isElement,
  not,
  targetedByCombinator,
  type Matcher,
} from '@domflax/pattern-kit';

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
/** Wrapper contains raw/dangerous HTML (hard opacity barrier). */
const hasDangerousHtml = metaFlag('hasDangerousHtml');

/**
 * Wrapper is a structural-pseudo target (:first/:last/:only/:nth-child/-of-type). Honours the
 * frontend-set meta flag and the precomputed {@link SelectorIndex}, exactly like
 * {@link targetedByCombinator}. Unwrapping such a node would change a selector's match-set.
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

/* ───────────────────────── match predicate ───────────────────────── */

/**
 * A `<div>` whose only role is a layout-neutral wrapper around a single element child: a plain
 * `display:block` box with no own visual style, no box/formatting/stacking context, not a containing
 * block, no custom-property coupling, and free of every opacity / selector-targeting barrier.
 */
const isEmptyStyleDiv: Matcher = and(
  isElement('div'),
  hasSingleElementChild,
  // layout-neutral: a plain block box that paints & establishes nothing.
  not(hasNonBlockDisplay),
  not(hasOwnVisualStyle),
  not(establishesBox),
  not(establishesFormattingContext),
  not(establishesStackingContext),
  not(isContainingBlock),
  not(declaresCustomProperties),
  // hard opacity barriers.
  not(hasRef),
  not(hasEventHandlers),
  not(hasDynamicChildren),
  not(hasDangerousHtml),
  // CSS-selector safety: removing the box must not change any selector's match-set.
  not(targetedByCombinator),
  not(targetedByStructuralPseudo),
);

/* ───────────────────────── the pattern ───────────────────────── */

/**
 * Flatten a layout-neutral, style-free `<div>` wrapper into its sole element child.
 */
export const emptyStyleDiv: Pattern = definePattern({
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
  evaluate(ctx: MatchContext, rw: RewriteFactory): MatchResult | null {
    const wrapper = ctx.node;
    if (!isEmptyStyleDiv(wrapper as unknown as NodeLike, ctx)) return null;

    const child = ctx.onlyElementChild();
    if (!child) return null;

    const ops: readonly RewriteOpDraft[] = [
      // 1. Preserve inheritable values (color/font/…) by folding them onto the child first.
      rw.foldInheritedStyles(wrapper, child, { conditions: 'all' }),
      // 2. Replace the wrapper with the child (structural-safe; preserves the child's IRNodeId).
      rw.unwrap(wrapper),
    ];

    return { ops };
  },
});
