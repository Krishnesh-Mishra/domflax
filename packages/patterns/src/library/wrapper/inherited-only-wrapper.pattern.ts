/**
 * @domflax/patterns — flatten pattern: `inherited-only-wrapper`.
 *
 * Collapses a paint-free wrapper whose ONLY own declarations are INHERITED properties
 * (`text-align`, `color`, `font-*`, `line-height`, `letter-spacing`, `white-space`, …):
 *
 *   <div style="text-align:center"><Child/></div>   →   <Child style="text-align:center"/>
 *
 * An inherited property on a wrapper reaches its descendants purely through inheritance, so folding it
 * onto the sole child and removing the box is render-identical — the child (and everything below it)
 * still sees the same inherited value. The wrapper carries nothing NON-inherited (no padding, margin,
 * sizing, border, background, layout), so its box contributes nothing to flow or paint.
 *
 * Distinct from `passthrough-wrapper` in INTENT: it recognizes the common "styling wrapper" idiom —
 * a box that exists only to set an inherited text/font property on a subtree — and pushes that intent
 * down onto the child. `foldInheritedStyles` (auto-applied by the flatten recipe) performs the fold;
 * the `where` predicate restricts the match to wrappers whose entire own style is inheritable.
 */

import { definePattern, normalizer, type Matcher } from '@domflax/pattern-kit';

/**
 * The wrapper carries at least one own declaration and EVERY own declaration is an inherited property
 * — so the whole wrapper style survives the box removal by being folded onto the child.
 */
const hasOnlyInheritedStyle: Matcher = (node, ctx) => {
  const sm = normalizer.normalizeStyleMap(ctx.computed());
  let sawAny = false;
  for (const block of sm.blocks.values()) {
    for (const decl of block.decls.values()) {
      sawAny = true;
      const inherited = decl.inherited || normalizer.inherited.isInherited(decl.property);
      if (!inherited) return false;
    }
  }
  return sawAny;
};

/**
 * Flatten a wrapper whose only own style is inherited into its sole element child (folding the
 * inherited declarations down first so the subtree keeps the same inherited values).
 */
export const inheritedOnlyWrapper = definePattern({
  name: 'inherited-only-wrapper',
  category: 'flatten/wrapper/inherited-only-wrapper',
  safety: 2,
  doc: {
    title: 'Flatten inherited-only styling wrapper',
    summary:
      'A paint-free wrapper whose only own declarations are inherited properties (text-align, color, ' +
      'font-*, …) is removed; its inherited style is folded onto the sole child, which keeps the ' +
      'same inherited values for the whole subtree.',
    before: '<div style="text-align:center"><Child/></div>',
    after: '<Child style="text-align:center"/>',
    safetyRationale:
      'Inherited properties reach descendants purely through inheritance, so folding them onto the ' +
      'child and removing the box is render-identical. The wrapper carries nothing non-inherited, ' +
      'establishes no box/formatting/stacking context, and is guarded by the auto-applied ' +
      'opacity-barrier + selector-safety set.',
  },
  match: {
    onlyChild: 'element',
    paintsNothing: true,
    where: hasOnlyInheritedStyle,
  },
  rewrite: { flattenInto: 'child' },
  test: {
    cases: [
      {
        // `text-align:center` is inherited → folded onto the child; the paint-free wrapper is removed.
        before: '<div className="text-center"><p className="bg-red-200">x</p></div>',
        after: '<p className="bg-red-200 text-center">x</p>',
      },
    ],
    noMatch: [
      // `p-4` is a NON-inherited padding: removing the box would drop it, so the flatten-safety gate
      // reverts the unwrap and the wrapper is left unchanged.
      '<div className="p-4"><p className="bg-red-200">x</p></div>',
    ],
  },
});
