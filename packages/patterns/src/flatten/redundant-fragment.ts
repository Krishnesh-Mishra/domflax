/**
 * @domflax/patterns — Stage-1 flatten pattern: `redundant-fragment`.
 *
 * Collapses a fragment that wraps exactly one child
 *
 *   <><Child/></>            →   <Child/>
 *
 * A fragment renders no box of its own, so a fragment whose sole purpose is to wrap a single node
 * is pure structural noise: splicing the child up into the fragment's slot is invisible in both
 * the rendered DOM and the project's CSS cascade.
 *
 * Safety reasoning (why this is sound):
 *   • the fragment establishes no box / paints nothing (fragments have no `computed` style at all),
 *     so removing it loses no pixels and folds no styles;
 *   • it carries exactly ONE child, so unwrapping does NOT change the child's sibling set in the
 *     parent — `:first/last/only-child`, `>`/`+`/`~` match-sets for the child and its (absent)
 *     siblings are preserved;
 *   • it is not a keyed fragment (`<Fragment key>`), carries no ref / event handlers / dynamic
 *     children / dangerous HTML / spread / component identity — the hard opacity barriers that would
 *     attach JS identity or behaviour to the fragment element;
 *   • neither the fragment nor its reparented child is a combinator / structural-pseudo selector
 *     subject, and the SelectorIndex reports no `reparentImpact` — so no project CSS targeting moves.
 *
 * Anchoring: the pass manager only visits ELEMENT nodes (see core's `elementIds`), never fragments,
 * so this pattern is anchored on the fragment's sole *element* child and removes the PARENT fragment.
 * (A fragment whose only child is a text/expr/comment node is consequently left alone — the common,
 * load-bearing case is a fragment wrapping a single element.)
 *
 * Realization: "replace the fragment with the child" is performed with the structural-safe `unwrap`
 * op — for a single-child fragment, unwrapping splices the child into the fragment's slot and deletes
 * ONLY the fragment node, preserving the child's `IRNodeId` (invariant D10). (`replaceWith` +
 * `keep(child)` cannot be used: the applier's `replaceWith` calls `removeSubtree` on the fragment,
 * which would also delete the still-parented child.)
 */

import type {
  DeepReadonly,
  ElementLike,
  IRNode,
  IRNodeId,
  MatchContext,
  MatchResult,
  NodeLike,
  Pattern,
  RewriteFactory,
  RewriteOpDraft,
} from '@domflax/core';

import { and, definePattern, isElement, type Matcher } from '@domflax/pattern-kit';

/* ───────────────────────── match predicate ───────────────────────── */

/**
 * Matches an element whose PARENT is a redundant, unwrappable fragment: a non-root fragment with
 * exactly one child (this element), free of every opacity barrier and CSS-targeting coupling.
 *
 * The fragment's barriers/targeting are read directly off the parent's `meta` + the SelectorIndex —
 * the combinator-vocabulary matchers (`hasRef`, `targetedByCombinator`, …) only inspect ELEMENT
 * nodes, so they cannot reason about a fragment passed as the anchor.
 */
const parentIsRedundantFragment: Matcher = (node, ctx) => {
  const el = node as DeepReadonly<IRNode>;
  if (el.kind !== 'element') return false;

  const parentId = el.parent;
  if (parentId == null) return false;

  const parent = ctx.doc.nodes.get(parentId);
  if (!parent || parent.kind !== 'fragment') return false;

  // Never unwrap the document root (it must always be a fragment — IRDocument invariant).
  if (parent.parent == null) return false;

  // Exactly one child (counting EVERY kind) ⇒ the anchor element is the fragment's sole child.
  if (parent.children.length !== 1) return false;

  // Hard opacity barriers on the fragment: keyed `<Fragment key>`, ref/handlers/dynamic children/
  // dangerous HTML/spread/component identity. Any of these means the fragment is load-bearing.
  const m = parent.meta;
  if (
    m.hasKey ||
    m.hasRef ||
    m.hasEventHandlers ||
    m.hasDynamicChildren ||
    m.hasDangerousHtml ||
    m.hasSpreadAttrs ||
    m.isComponent
  ) {
    return false;
  }

  // CSS-selector safety: the fragment (or its reparented child) must not move any combinator /
  // structural-pseudo match-set. Honour both the frontend-set meta flags and the SelectorIndex.
  if (m.targetedByCombinator || m.targetedByStructuralPseudo) return false;
  const fid = parentId as unknown as IRNodeId;
  if (ctx.selectors.targetedByCombinator(fid) || ctx.selectors.targetedByStructuralPseudo(fid)) {
    return false;
  }
  if (ctx.selectors.reparentImpact(fid).size > 0) return false;

  return true;
};

/** Anchor on any element whose parent is a redundant fragment. */
const isRedundantFragmentChild: Matcher = and(isElement(), parentIsRedundantFragment);

/* ───────────────────────── the pattern ───────────────────────── */

/**
 * Flatten a fragment that wraps exactly one child into that child.
 *
 * Safety level 1 (`safe`): a purely structural, style-free, selector-transparent cleanup.
 */
export const redundantFragment: Pattern = definePattern({
  name: 'redundant-fragment',
  category: 'flatten/redundant-fragment',
  safety: 1,
  doc: {
    title: 'Flatten redundant single-child fragment',
    summary:
      'A fragment whose only child is a single node is removed; the child is spliced up into the ' +
      "fragment's slot, preserving its IRNodeId, siblings, attributes and the CSS cascade.",
    before: '<><Child/></>',
    after: '<Child/>',
    safetyRationale:
      'A fragment paints nothing and renders no box; with exactly one child its removal changes ' +
      'no sibling/structural-pseudo match-set. Keyed fragments and fragments carrying ' +
      'ref/handlers/dynamic-children/raw-html/spread are excluded as opacity barriers.',
  },
  evaluate(ctx: MatchContext, rw: RewriteFactory): MatchResult | null {
    const child = ctx.node;
    if (!isRedundantFragmentChild(child as unknown as NodeLike, ctx)) return null;

    const parentId = child.parent;
    if (parentId == null) return null;
    const fragment = ctx.doc.nodes.get(parentId);
    if (!fragment || fragment.kind !== 'fragment') return null;

    const ops: readonly RewriteOpDraft[] = [
      // Splice the sole child up into the fragment's slot, deleting ONLY the fragment node.
      rw.unwrap(fragment as unknown as ElementLike),
    ];

    return { ops };
  },
});
