/**
 * @domflax/patterns — flatten pattern: `block-wrapper-of-grid`.
 *
 * Removes a redundant plain-block wrapper around a grid container:
 *
 *   <div><div style="display:grid; …">…</div></div>   →   <div style="display:grid; …">…</div>
 *
 * A styleless, paint-free BLOCK `<div>` whose sole child is a grid container contributes nothing to
 * layout — the grid establishes its own formatting context and lays its items out identically whether
 * or not the inert block box sits above it. Removing the OUTER block and hoisting the grid is
 * layout-identical. This is the "extra wrapper div around my grid" cleanup that appears constantly in
 * hand-written and generated markup.
 *
 * The OUTER (removed) box is a plain block, so this is a `provably-safe` flatten under the conservative
 * gate. The `where` predicate documents the recognized shape (sole child is a grid container); the
 * opacity-barrier + selector-safety guards and the layout-neutrality gate are applied automatically.
 */

import type { CssProperty, NodeLike, StyleMap } from '@domflax/core';

import { definePattern, type Matcher } from '@domflax/pattern-kit';

const DISPLAY = 'display' as CssProperty;
const GRID_DISPLAYS: ReadonlySet<string> = new Set(['grid', 'inline-grid']);

/** The sole element child is a grid container (display:grid / inline-grid) in its computed style. */
const soleChildIsGrid: Matcher = (node, ctx) => {
  const child = ctx.onlyElementChild();
  if (!child) return false;
  const sm: StyleMap = ctx.computedOf(child as unknown as NodeLike);
  for (const block of sm.blocks.values()) {
    const d = block.decls.get(DISPLAY);
    if (d && GRID_DISPLAYS.has(String(d.value))) return true;
  }
  return false;
};

/**
 * Flatten a paint-free block wrapper whose sole child is a grid container into that grid container.
 */
export const blockWrapperOfGrid = definePattern({
  name: 'block-wrapper-of-grid',
  category: 'flatten/grid/block-wrapper-of-grid',
  safety: 2,
  doc: {
    title: 'Flatten redundant block wrapper around a grid',
    summary:
      'A paint-free block div whose only child is a grid container is removed; the grid is hoisted ' +
      'into its place (the grid already establishes its own formatting context).',
    before: '<div><div className="grid">…</div></div>',
    after: '<div className="grid">…</div>',
    safetyRationale:
      'The removed OUTER box is a plain block that paints nothing and establishes no ' +
      'box/formatting/stacking context; the inner grid lays out identically with or without it. ' +
      'Opacity-barrier + selector-safety guards are auto-applied, and the flatten-safety gate reverts ' +
      'the removal for any outer wrapper carrying an own style the grid does not reproduce.',
  },
  match: {
    tag: 'div',
    onlyChild: 'element',
    paintsNothing: true,
    where: soleChildIsGrid,
  },
  rewrite: { flattenInto: 'child' },
  test: {
    cases: [
      {
        // The inert outer block is removed; the grid container survives unchanged.
        before: '<div><div className="grid grid-cols-2"><span className="bg-red-200">x</span></div></div>',
        after: '<div className="grid grid-cols-2"><span className="bg-red-200">x</span></div>',
      },
    ],
    noMatch: [
      // The outer box paints its own background → not layout-neutral, so nothing is removed; unchanged.
      '<div className="bg-blue-500"><div className="grid grid-cols-2"><span className="bg-red-200">x</span></div></div>',
    ],
  },
});
