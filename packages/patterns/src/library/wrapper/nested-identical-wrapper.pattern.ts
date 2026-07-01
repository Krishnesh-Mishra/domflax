/**
 * @domflax/patterns — flatten pattern: `nested-identical-wrapper`.
 *
 * Collapses a redundant DOUBLE-wrapping where a layout-neutral element wraps a single child that is
 * ITSELF a layout-neutral element with the SAME computed style:
 *
 *   <div><div><Child/></div></div>            →   <div><Child/></div>
 *   <div className="x"><div className="x"><Child/></div></div>   →   <div className="x"><Child/></div>
 *
 * When the outer and inner boxes are indistinguishable (identical normalized computed style, both
 * painting nothing) one of the two boxes is pure structural noise: removing the OUTER box and hoisting
 * the (identical) inner box is layout-identical. This is the "double-wrapped container" idiom bundlers
 * and hand-written markup produce constantly (`<div><div>…</div></div>`).
 *
 * Distinct from `passthrough-wrapper` in INTENT — it recognizes the specific redundant-nesting shape
 * (relational: outer ≈ inner) rather than any styleless wrapper — though under the conservative gate
 * the general passthrough may collapse the same nodes. The opacity-barrier + selector-safety guards
 * are auto-applied for every `flatten/*` pattern; the `where` predicate adds the relational
 * requirement (the sole element child is an identical, paint-free element).
 */

import type { NodeLike } from '@domflax/core';

import { definePattern, normalizer, not, hasOwnVisualStyle, type Matcher } from '@domflax/pattern-kit';

/* ───────────────────────── relational matcher ───────────────────────── */

/**
 * The sole element child is an element with the SAME normalized computed style as the wrapper and
 * paints nothing of its own — i.e. the two boxes are interchangeable, so removing the outer is
 * layout-identical (the inner survives unchanged).
 */
const soleChildIsIdenticalPaintFree: Matcher = (node, ctx) => {
  const child = ctx.onlyElementChild();
  if (!child) return false;
  const childLike = child as unknown as NodeLike;
  if (hasOwnVisualStyle(childLike, ctx)) return false;
  return normalizer.equals(ctx.computed(), ctx.computedOf(childLike));
};

/* ───────────────────────── the pattern ───────────────────────── */

/**
 * Flatten the OUTER of two nested, identically-styled, paint-free boxes into the (surviving) inner box.
 */
export const nestedIdenticalWrapper = definePattern({
  name: 'nested-identical-wrapper',
  category: 'flatten/wrapper/nested-identical-wrapper',
  safety: 2,
  doc: {
    title: 'Collapse identically-styled nested wrappers',
    summary:
      'When a paint-free wrapper wraps a single child that is itself a paint-free element with an ' +
      'identical computed style, the outer box is removed and the identical inner box survives.',
    before: '<div><div><Child/></div></div>',
    after: '<div><Child/></div>',
    safetyRationale:
      'The outer and inner boxes are indistinguishable (identical normalized computed style, both ' +
      'paint-free); the outer establishes no box/formatting/stacking context the inner does not also ' +
      'establish, so removing it is layout-identical. Opacity-barrier + selector-safety guards are ' +
      'auto-applied, and the flatten-safety gate reverts the removal for any wrapper carrying an own ' +
      'style the inner does not reproduce.',
  },
  match: {
    onlyChild: 'element',
    paintsNothing: true,
    where: soleChildIsIdenticalPaintFree,
  },
  rewrite: { flattenInto: 'child' },
  test: {
    cases: [
      {
        // Two nested paint-free divs collapse to one (the general passthrough co-fires under the
        // conservative gate, so the whole redundant nest reduces to the painted leaf).
        before: '<div><div><span className="bg-red-200">x</span></div></div>',
        after: '<span className="bg-red-200">x</span>',
      },
    ],
    noMatch: [
      // Both boxes paint their own background → not paint-free (and no other flatten pattern fires),
      // so the whole nest is left byte-for-byte unchanged.
      '<div className="bg-blue-500"><div className="bg-blue-500"><span className="bg-red-200">x</span></div></div>',
    ],
  },
});
