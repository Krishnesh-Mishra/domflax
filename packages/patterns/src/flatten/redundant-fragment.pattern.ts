/**
 * @domflax/patterns — flatten pattern: `redundant-fragment`.
 *
 * Collapses a fragment that wraps exactly one child
 *
 *   <><Child/></>            →   <Child/>
 *
 * A fragment renders no box of its own, so a fragment whose sole purpose is to wrap a single node
 * is pure structural noise: splicing the child up into the fragment's slot is invisible in both
 * the rendered DOM and the project's CSS cascade.
 *
 * Anchoring: the pass manager only visits ELEMENT nodes (see core's `elementIds`), never fragments,
 * so this pattern is anchored on the fragment's sole *element* child and removes the PARENT fragment.
 * Because the match is PARENT-anchored (and reads a fragment's `meta`, which the element-only
 * combinator vocabulary cannot inspect), it uses the declarative API's two escape hatches: a raw
 * `match` predicate and a raw `rewrite` op-draft factory.
 */

import type {
  DeepReadonly,
  ElementLike,
  IRNode,
  IRNodeId,
  MatchContext,
  NodeLike,
  RewriteFactory,
  RewriteOpDraft,
} from '@domflax/core';

import { pattern } from '@domflax/pattern-kit';

/* ───────────────────────── match predicate (escape hatch) ───────────────────────── */

/**
 * Matches an element whose PARENT is a redundant, unwrappable fragment: a non-root fragment with
 * exactly one child (this element), free of every opacity barrier and CSS-targeting coupling.
 */
function parentIsRedundantFragment(node: NodeLike, ctx: MatchContext): boolean {
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
}

/* ───────────────────────── the pattern ───────────────────────── */

/**
 * Flatten a fragment that wraps exactly one child into that child.
 *
 * Safety level 1 (`safe`): a purely structural, style-free, selector-transparent cleanup.
 */
export const redundantFragment = pattern({
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
  match: parentIsRedundantFragment,
  rewrite: (ctx: MatchContext, rw: RewriteFactory): readonly RewriteOpDraft[] | null => {
    const parentId = ctx.node.parent;
    if (parentId == null) return null;
    const fragment = ctx.doc.nodes.get(parentId);
    if (!fragment || fragment.kind !== 'fragment') return null;
    // Splice the sole child up into the fragment's slot, deleting ONLY the fragment node.
    return [rw.unwrap(fragment as unknown as ElementLike)];
  },
  examples: [
    {
      before: '<><span className="bg-red-200">Hi</span></>',
      after: '<span className="bg-red-200">Hi</span>',
    },
    {
      // Two children ⇒ not a single-child fragment, so the fragment is load-bearing and stays.
      noMatch:
        '<><span className="bg-red-200">A</span><span className="bg-green-200">B</span></>',
    },
  ],
});
