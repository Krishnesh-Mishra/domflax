/**
 * @domflax/patterns — flatten pattern: `redundant-contents-nesting`.
 *
 * Collapses two nested `display:contents` boxes:
 *
 *   <div style="display:contents"><div style="display:contents"><Child/></div></div>
 *     → <div style="display:contents"><Child/></div>
 *
 * A `display:contents` element generates NO box; nesting two of them is doubly-redundant — the outer
 * contents box is pure structural noise around an inner box that is itself already a passthrough.
 * Removing the outer and hoisting the inner is layout-identical.
 *
 * Distinct from `display-contents-wrapper` in INTENT (it targets the nested contents-in-contents shape,
 * relationally) — though under the conservative gate the general contents-wrapper flatten collapses the
 * same nodes. The opacity-barrier + selector-safety guards are auto-applied for every `flatten/*`
 * pattern; the `where` predicate adds the requirement that the sole element child is ALSO a
 * `display:contents` box.
 */

import type { CssProperty, NodeLike, StyleMap } from '@domflax/core';

import { definePattern, type Matcher } from '@domflax/pattern-kit';

const DISPLAY = 'display' as CssProperty;

/** The sole element child sets `display:contents` in its computed style (in any condition). */
const soleChildIsContents: Matcher = (node, ctx) => {
  const child = ctx.onlyElementChild();
  if (!child) return false;
  const sm: StyleMap = ctx.computedOf(child as unknown as NodeLike);
  for (const block of sm.blocks.values()) {
    const d = block.decls.get(DISPLAY);
    if (d && String(d.value) === 'contents') return true;
  }
  return false;
};

/**
 * Flatten the OUTER of two nested `display:contents` boxes into the (surviving) inner contents box.
 */
export const redundantContentsNesting = definePattern({
  name: 'redundant-contents-nesting',
  category: 'flatten/wrapper/redundant-contents-nesting',
  safety: 2,
  doc: {
    title: 'Collapse nested display:contents boxes',
    summary:
      'A display:contents wrapper whose only child is itself a display:contents box is doubly ' +
      'redundant; the outer box is removed and the inner passthrough survives.',
    before: '<div style="display:contents"><div style="display:contents"><Child/></div></div>',
    after: '<div style="display:contents"><Child/></div>',
    safetyRationale:
      'A display:contents element generates no box, so neither the outer nor the inner participates ' +
      'in layout; removing the outer is layout-identical. Opacity-barrier + selector-safety guards ' +
      'are auto-applied, and inheritable styles are folded onto the surviving child before removal.',
  },
  match: {
    tag: 'div',
    style: { display: 'contents' },
    onlyChild: 'element',
    paintsNothing: true,
    where: soleChildIsContents,
  },
  rewrite: { flattenInto: 'child' },
  test: {
    cases: [
      {
        // Two nested contents boxes collapse (the general contents-wrapper flatten co-fires under the
        // conservative gate, reducing the whole nest to the painted leaf).
        before:
          '<div className="contents"><div className="contents"><span className="bg-red-200">x</span></div></div>',
        after: '<span className="bg-red-200">x</span>',
      },
    ],
    noMatch: [
      // Painted, non-contents nesting → no contents box to collapse and nothing else fires; unchanged.
      '<div className="bg-blue-500"><div className="bg-green-500"><span className="bg-red-200">x</span></div></div>',
    ],
  },
});
