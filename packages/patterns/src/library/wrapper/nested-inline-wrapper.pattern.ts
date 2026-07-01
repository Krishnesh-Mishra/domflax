/**
 * @domflax/patterns — flatten pattern: `nested-inline-wrapper`.
 *
 * Collapses two nested paint-free inline `<span>` boxes:
 *
 *   <span><span><Child/></span></span>   →   <span><Child/></span>
 *
 * An empty inline box merely wraps its child's box; nesting two of them adds nothing to paint or flow,
 * so removing the OUTER span and hoisting the inner is invisible in both. This is the inline analogue
 * of `nested-identical-wrapper`, targeting the ubiquitous `<span><span>…</span></span>` double-wrap
 * that i18n/rich-text/highlighting layers emit.
 *
 * Distinct from `redundant-inline-wrapper` in INTENT (it recognizes the nested-span shape relationally)
 * — though under the conservative gate the general inline-wrapper flatten collapses the same nodes. The
 * opacity-barrier + selector-safety guards are auto-applied for every `flatten/*` pattern; the `where`
 * predicate requires the sole element child to itself be a `<span>`.
 */

import { definePattern, isElement, type Matcher } from '@domflax/pattern-kit';

/** The sole element child is itself a `<span>` (the nested inline box we hoist). */
const soleChildIsSpan: Matcher = (node, ctx) => {
  const child = ctx.onlyElementChild();
  if (!child) return false;
  return isElement('span')(child as never, ctx);
};

/**
 * Flatten the OUTER of two nested paint-free inline spans into the (surviving) inner span.
 */
export const nestedInlineWrapper = definePattern({
  name: 'nested-inline-wrapper',
  category: 'flatten/wrapper/nested-inline-wrapper',
  safety: 2,
  doc: {
    title: 'Collapse nested inline spans',
    summary:
      'A paint-free inline span whose only child is itself a span is doubly redundant; the outer ' +
      'inline box is removed and the inner span survives.',
    before: '<span><span><Child/></span></span>',
    after: '<span><Child/></span>',
    safetyRationale:
      'An empty inline box paints nothing and establishes no layout/paint/var context; with the ' +
      'inline default display and a single element child, removing the outer changes no paint and no ' +
      'flow. Opacity-barrier + selector-safety guards are auto-applied, and inheritable styles are ' +
      'folded onto the surviving span before removal.',
  },
  match: {
    tag: 'span',
    onlyChild: 'element',
    paintsNothing: true,
    where: soleChildIsSpan,
  },
  rewrite: { flattenInto: 'child' },
  test: {
    cases: [
      {
        // Two nested paint-free spans collapse (the general inline-wrapper flatten co-fires under the
        // conservative gate, reducing the whole nest to the painted leaf).
        before: '<span><span><a className="text-blue-500">L</a></span></span>',
        after: '<a className="text-blue-500">L</a>',
      },
    ],
    noMatch: [
      // Both spans paint their own background → not paint-free, so nothing fires; left unchanged.
      '<span className="bg-green-200"><span className="bg-green-200"><a className="text-blue-500">L</a></span></span>',
    ],
  },
});
