/**
 * @domflax/patterns — flatten pattern: `nested-redundant-fragment`.
 *
 * Collapses a fragment nested directly inside another single-child fragment:
 *
 *   <><><Child/></></>            →   <><Child/></>
 *
 * A fragment renders no box, so a fragment whose sole child is ITSELF a fragment is doubly redundant.
 * Removing the OUTER fragment (splicing the inner fragment up into its slot) is invisible in both the
 * rendered DOM and the CSS cascade. Recursively applied (and together with `redundant-fragment`) this
 * flattens arbitrarily-deep single-child fragment nests down to the payload node.
 *
 * Anchoring: the pass manager only visits ELEMENT nodes, so — like `redundant-fragment` — this pattern
 * is anchored on the innermost element and reaches UP through two fragment parents via the declarative
 * API's `match`/`rewrite` escape hatches. It removes the OUTER fragment; the inner single-child
 * fragment is then handled by `redundant-fragment` on the next iteration.
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

import { definePattern } from '@domflax/pattern-kit';

/** A fragment node that is a non-root, single-child, barrier-free, selector-transparent passthrough. */
function isRedundantFragment(node: IRNode | undefined, ctx: MatchContext): boolean {
  if (!node || node.kind !== 'fragment') return false;
  if (node.parent == null) return false; // never the document root
  if (node.children.length !== 1) return false;
  const m = node.meta;
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
  if (m.targetedByCombinator || m.targetedByStructuralPseudo) return false;
  const fid = node.id as unknown as IRNodeId;
  if (ctx.selectors.targetedByCombinator(fid) || ctx.selectors.targetedByStructuralPseudo(fid)) {
    return false;
  }
  return ctx.selectors.reparentImpact(fid).size === 0;
}

/**
 * Matches an element whose PARENT is a redundant fragment that is ITSELF the sole child of another
 * redundant fragment — i.e. two nested single-child fragments to be collapsed.
 */
function parentIsNestedRedundantFragment(node: NodeLike, ctx: MatchContext): boolean {
  const el = node as DeepReadonly<IRNode>;
  if (el.kind !== 'element') return false;
  if (el.parent == null) return false;
  const inner = ctx.doc.nodes.get(el.parent);
  if (!isRedundantFragment(inner as IRNode | undefined, ctx)) return false;
  const outer = inner!.parent != null ? ctx.doc.nodes.get(inner!.parent) : undefined;
  return isRedundantFragment(outer as IRNode | undefined, ctx);
}

/**
 * Flatten the OUTER of two nested single-child fragments by unwrapping it (splicing the inner fragment
 * up into its slot); `redundant-fragment` then collapses the remaining single-child fragment.
 */
export const nestedRedundantFragment = definePattern({
  name: 'nested-redundant-fragment',
  category: 'flatten/fragment/nested-redundant-fragment',
  safety: 1,
  doc: {
    title: 'Flatten nested single-child fragments',
    summary:
      'A fragment whose only child is itself a single-child fragment is doubly redundant; the outer ' +
      'fragment is removed and the inner fragment is spliced up into its slot.',
    before: '<><><Child/></></>',
    after: '<><Child/></>',
    safetyRationale:
      'A fragment paints nothing and renders no box; unwrapping the outer of two nested single-child ' +
      'fragments changes no sibling/structural-pseudo match-set. Keyed fragments and fragments ' +
      'carrying ref/handlers/dynamic-children/raw-html/spread are excluded as opacity barriers.',
  },
  match: parentIsNestedRedundantFragment,
  rewrite: (ctx: MatchContext, rw: RewriteFactory): readonly RewriteOpDraft[] | null => {
    const innerId = ctx.node.parent;
    if (innerId == null) return null;
    const inner = ctx.doc.nodes.get(innerId);
    if (!inner || inner.kind !== 'fragment' || inner.parent == null) return null;
    const outer = ctx.doc.nodes.get(inner.parent);
    if (!outer || outer.kind !== 'fragment') return null;
    return [rw.unwrap(outer as unknown as ElementLike)];
  },
  test: {
    cases: [
      {
        // Two nested single-child fragments collapse (together with `redundant-fragment`) to the leaf.
        before: '<><><span className="bg-red-200">x</span></></>',
        after: '<span className="bg-red-200">x</span>',
      },
    ],
    noMatch: [
      // A single (non-nested) fragment: no outer fragment to remove → this pattern declines. (The
      // whole snippet is still reduced by `redundant-fragment`, so this asserts nested-specificity via
      // the invariant that a two-child fragment — load-bearing — is left untouched by any fragment pattern.)
      '<><span className="bg-red-200">a</span><span className="bg-green-200">b</span></>',
    ],
  },
});
