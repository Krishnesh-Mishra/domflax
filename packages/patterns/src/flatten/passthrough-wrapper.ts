/**
 * @domflax/patterns — Stage-1 flatten pattern: `passthrough-wrapper`.
 *
 * Collapses a purely-structural wrapper that exists for no reason at all:
 *
 *   <div><Child/></div>
 *
 * The wrapper paints nothing, establishes no box / formatting / stacking context, carries no
 * attributes beyond an (optional) inert class, holds exactly one element child, and is free of every
 * opacity barrier (ref / event-handlers / dynamic children / dangerous html / spread / component).
 * Such a `<div>` is pure DOM noise: removing it and hoisting the child is invisible to both paint
 * and layout.
 *
 * Safety reasoning (why this is sound):
 *   • the wrapper paints nothing of its own (`hasOwnVisualStyle` is false across every condition),
 *     so removing its box loses no pixels;
 *   • it establishes no box / formatting / stacking context and is not a containing block, so the
 *     child's layout is unchanged when it is reparented into the wrapper's slot;
 *   • it declares no custom properties read by a descendant (no `--*` coupling across the boundary);
 *   • it carries no ref / event handlers / dynamic children / dangerous html / spread / component
 *     identity (hard opacity barriers), so no JS behaviour or identity is attached to the box;
 *   • it owns no attributes (id / data-*) that a project selector or script could target, and any
 *     class it carries is static and not a combinator/structural-pseudo subject — so no CSS targets
 *     it and nothing changes the match-set of its child or former siblings (`reparentImpact` empty);
 *   • inheritable declarations on the wrapper (color, font, …) are folded onto the child first, so
 *     inherited values survive the box removal.
 *
 * Realization: "replace the wrapper with the child" is performed with the structural-safe `unwrap`
 * op — for a single-element-child wrapper, unwrapping splices the child into the wrapper's slot and
 * deletes ONLY the wrapper node, preserving the child's `IRNodeId` (invariant D10).
 */

import type {
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
} from '@domflax/core';

import {
  and,
  definePattern,
  hasDynamicChildren,
  hasDynamicClasses,
  hasEventHandlers,
  hasOwnVisualStyle,
  hasRef,
  hasSingleElementChild,
  isElement,
  not,
  targetedByCombinator,
  type Matcher,
} from '@domflax/pattern-kit';

/* ───────────────────────── local meta/attr/selector matchers ───────────────────────── */

/** Narrow a {@link NodeLike} to its element {@link NodeMeta}, or `null` for non-elements. */
function metaOf(node: NodeLike): DeepReadonly<NodeMeta> | null {
  const n = node as DeepReadonly<IRNode>;
  return n.kind === 'element' ? (n as DeepReadonly<IRElement>).meta : null;
}

function elementOf(node: NodeLike): DeepReadonly<IRElement> | null {
  const n = node as DeepReadonly<IRNode>;
  return n.kind === 'element' ? (n as DeepReadonly<IRElement>) : null;
}

/**
 * Element establishes some box / formatting / stacking context, is a containing block, or exposes
 * custom properties to a descendant — any of which means removing its box could shift layout or
 * break a `var()` coupling, so it is NOT a passthrough.
 */
const establishesContext: Matcher = (node) => {
  const m = metaOf(node);
  if (!m) return false;
  return (
    m.establishesBox ||
    m.establishesFormattingContext ||
    m.establishesStackingContext ||
    m.isContainingBlock ||
    m.declaresCustomProperties
  );
};

/** Hard opacity barriers beyond ref/handlers/dynamic-children: raw html, spread attrs, component. */
const hasDangerousHtml: Matcher = (node) => metaOf(node)?.hasDangerousHtml ?? false;
const hasSpreadAttrs: Matcher = (node) => metaOf(node)?.hasSpreadAttrs ?? false;
const isComponentNode: Matcher = (node) => metaOf(node)?.isComponent ?? false;

/** Element carries own attributes (id / data-* / …) beyond its class list — possible selector/JS hook. */
const hasOwnAttrs: Matcher = (node) => {
  const el = elementOf(node);
  if (!el) return false;
  return el.attrs.entries.size > 0 || el.attrs.spreads.length > 0;
};

/**
 * Element is the subject of a structural pseudo (`:first/:last/:only/:nth-*`). Honours the meta flag
 * and the precomputed {@link SelectorIndex}.
 */
const targetedByStructuralPseudo: Matcher = (node, ctx) => {
  const el = elementOf(node);
  if (!el) return false;
  if (el.meta.targetedByStructuralPseudo) return true;
  return ctx.selectors.targetedByStructuralPseudo(el.id as unknown as IRNodeId);
};

/**
 * Removing/unwrapping this node would change the combinator / structural-pseudo match-set of itself,
 * its child, or a former sibling (review-1 blocker: guard the child & siblings, not just the wrapper).
 * Empty `reparentImpact` ⇒ structurally safe to hoist.
 */
const affectsSelectorMatching: Matcher = (node, ctx) => {
  const el = elementOf(node);
  if (!el) return false;
  return ctx.selectors.reparentImpact(el.id as unknown as IRNodeId).size > 0;
};

/* ───────────────────────── match predicate ───────────────────────── */

const isPassthroughWrapper: Matcher = and(
  isElement('div'),
  hasSingleElementChild,
  // paints nothing & establishes no layout/paint/var context of its own
  not(hasOwnVisualStyle),
  not(establishesContext),
  // no own attributes beyond an (optional) inert, static class
  not(hasOwnAttrs),
  not(hasDynamicClasses),
  // hard opacity barriers
  not(hasRef),
  not(hasEventHandlers),
  not(hasDynamicChildren),
  not(hasDangerousHtml),
  not(hasSpreadAttrs),
  not(isComponentNode),
  // CSS-selector safety: not a combinator/structural subject, and hoisting changes no match-set
  not(targetedByCombinator),
  not(targetedByStructuralPseudo),
  not(affectsSelectorMatching),
);

/* ───────────────────────── the pattern ───────────────────────── */

/**
 * Flatten a do-nothing `<div>` wrapper into its sole element child, folding any inheritable styles
 * down first so inherited values survive the box removal.
 */
export const passthroughWrapper: Pattern = definePattern({
  name: 'passthrough-wrapper',
  category: 'flatten/passthrough-wrapper',
  safety: 2,
  doc: {
    title: 'Flatten passthrough wrapper',
    summary:
      'A div with no own visual/box style, no attributes beyond an inert class, exactly one ' +
      'element child, and no opacity barriers is removed; its sole child is hoisted in its place.',
    before: '<div><Child/></div>',
    after: '<Child/>',
    safetyRationale:
      'Wrapper paints nothing and establishes no layout/paint/var context, carries no ' +
      'ref/handlers/dynamic-children/html/spread/component identity, owns no targetable attrs, ' +
      'and is not a combinator/structural-pseudo subject (reparenting changes no match-set); ' +
      'inheritable styles are folded onto the child before removal.',
  },
  evaluate(ctx: MatchContext, rw: RewriteFactory): MatchResult | null {
    const wrapper = ctx.node;
    if (!isPassthroughWrapper(wrapper as unknown as NodeLike, ctx)) return null;

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
