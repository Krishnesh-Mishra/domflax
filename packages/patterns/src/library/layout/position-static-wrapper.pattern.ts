/**
 * @domflax/patterns — flatten pattern: `position-static-wrapper`.
 *
 * Collapses a paint-free wrapper that pins `position:static` — the INITIAL value, which is inert:
 *
 *   <div style="position:static"><Child/></div>   →   <Child/>
 *
 * `position:static` establishes no containing block, applies no offsets, and creates no stacking
 * context — it is exactly "positioned like a normal flow element". A wrapper whose only distinguishing
 * declaration is `position:static` therefore contributes nothing removing it would drop; it is a plain
 * flow box and can be unwrapped into its sole child. (Tailwind's `static` utility, or a reset that
 * re-asserts the default, is the usual source.)
 *
 * The flatten-safety classifier treats `position:static`/`transform:none` as inert (they are skipped by
 * both the context and the drop-own-style checks), so this flatten is `provably-safe` and commits under
 * the conservative gate. A NON-static position (relative/absolute/…) establishes a containing block or
 * offsets the box, so the gate reverts those — this pattern only ever proposes the static case.
 */

import { definePattern } from '@domflax/pattern-kit';

/**
 * Flatten a paint-free `position:static` wrapper into its sole element child.
 */
export const positionStaticWrapper = definePattern({
  name: 'position-static-wrapper',
  category: 'flatten/layout/position-static-wrapper',
  safety: 2,
  doc: {
    title: 'Flatten position:static wrapper',
    summary:
      'A paint-free wrapper whose distinguishing declaration is the inert initial value ' +
      'position:static, wrapping a single child, is removed; the child is hoisted in its place.',
    before: '<div style="position:static"><Child/></div>',
    after: '<Child/>',
    safetyRationale:
      'position:static is the initial value: it establishes no containing block, applies no offset, ' +
      'and creates no stacking context, so removing the box changes nothing. The wrapper paints ' +
      'nothing and is guarded by the auto-applied opacity-barrier + selector-safety set; the ' +
      'flatten-safety gate reverts any wrapper that instead carries a non-static position.',
  },
  match: {
    tag: 'div',
    style: { position: 'static' },
    onlyChild: 'element',
    paintsNothing: true,
  },
  rewrite: { flattenInto: 'child' },
  test: {
    cases: [
      {
        // position:static is inert → a provably-safe flatten: the wrapper is removed, the child hoisted.
        before: '<div className="static"><span className="bg-red-200">x</span></div>',
        after: '<span className="bg-red-200">x</span>',
      },
    ],
    noMatch: [
      // position:relative establishes a containing block (a real, non-inert box), so the gate reverts
      // the unwrap and the wrapper is left unchanged.
      '<div className="relative"><span className="bg-red-200">x</span></div>',
    ],
  },
});
