/**
 * @domflax/patterns — flatten pattern: `block-wrapper-of-flex`.
 *
 * Removes a redundant plain-block wrapper around a flex container:
 *
 *   <div><div style="display:flex; …">…</div></div>   →   <div style="display:flex; …">…</div>
 *
 * A styleless, paint-free BLOCK `<div>` whose sole child is a flex container contributes nothing to
 * layout — the flex container establishes its own formatting context and lays its items out identically
 * whether or not the inert block box sits above it. Removing the OUTER block and hoisting the flex
 * container is layout-identical. This is the "extra wrapper div around my flex row/column" cleanup that
 * appears constantly in hand-written and generated markup.
 *
 * The OUTER (removed) box is a plain block, so this is a `provably-safe` flatten under the conservative
 * gate. The `where` predicate documents the recognized shape (sole child is a flex container); the
 * opacity-barrier + selector-safety guards and the layout-neutrality gate are applied automatically.
 */

import type { CssProperty, NodeLike, StyleMap } from '@domflax/core';

import { definePattern, type Matcher } from '@domflax/pattern-kit';

const DISPLAY = 'display' as CssProperty;
const FLEX_DISPLAYS: ReadonlySet<string> = new Set(['flex', 'inline-flex']);

/** The sole element child is a flex container (display:flex / inline-flex) in its computed style. */
const soleChildIsFlex: Matcher = (node, ctx) => {
  const child = ctx.onlyElementChild();
  if (!child) return false;
  const sm: StyleMap = ctx.computedOf(child as unknown as NodeLike);
  for (const block of sm.blocks.values()) {
    const d = block.decls.get(DISPLAY);
    if (d && FLEX_DISPLAYS.has(String(d.value))) return true;
  }
  return false;
};

/**
 * Flatten a paint-free block wrapper whose sole child is a flex container into that flex container.
 */
export const blockWrapperOfFlex = definePattern({
  name: 'block-wrapper-of-flex',
  category: 'flatten/flex/block-wrapper-of-flex',
  safety: 2,
  doc: {
    title: 'Flatten redundant block wrapper around a flex container',
    summary:
      'A paint-free block div whose only child is a flex container is removed; the flex container is ' +
      'hoisted into its place (it already establishes its own formatting context).',
    before: '<div><div className="flex">…</div></div>',
    after: '<div className="flex">…</div>',
    safetyRationale:
      'The removed OUTER box is a plain block that paints nothing and establishes no ' +
      'box/formatting/stacking context; the inner flex container lays out identically with or without ' +
      'it. Opacity-barrier + selector-safety guards are auto-applied, and the flatten-safety gate ' +
      'reverts the removal for any outer wrapper carrying an own style the flex child does not reproduce.',
  },
  match: {
    tag: 'div',
    onlyChild: 'element',
    paintsNothing: true,
    where: soleChildIsFlex,
  },
  rewrite: { flattenInto: 'child' },
  test: {
    cases: [
      {
        // The inert outer block is removed; the flex container survives unchanged.
        before: '<div><div className="flex flex-col"><span className="bg-red-200">x</span></div></div>',
        after: '<div className="flex flex-col"><span className="bg-red-200">x</span></div>',
      },
    ],
    noMatch: [
      // The outer box paints its own background → not layout-neutral, so nothing is removed; unchanged.
      '<div className="bg-blue-500"><div className="flex flex-col"><span className="bg-red-200">x</span></div></div>',
    ],
  },
});
