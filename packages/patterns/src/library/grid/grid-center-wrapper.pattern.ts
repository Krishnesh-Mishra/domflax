/**
 * @domflax/patterns — flatten pattern: `grid-center-wrapper`.
 *
 * Collapses the grid flavour of the "centering wrapper" idiom
 *
 *   <div style="display:grid; align-items:center; justify-content:center"><Child/></div>
 *
 * into its sole child, pushing the centering intent down onto the child as `place-self:center`. This is
 * the grid analogue of `flex-center-wrapper`: the wrapper only exists to center one element, and once
 * `place-self:center` lives on the child the wrapper is pure structural noise.
 *
 * Authored with the declarative {@link definePattern} API: the match is the grid-centering computed-style
 * signature on a single-element-child `<div>` that paints nothing of its own; the recipe folds
 * inheritable styles onto the child, grants it `place-self:center`, then unwraps the wrapper. The
 * opacity-barrier + selector-safety guards are auto-applied for every `flatten/*` pattern.
 *
 * Genuinely additive under the conservative gate: unlike a plain passthrough (which the gate REVERTS on
 * a grid wrapper because grid establishes a formatting context), the compensating `place-self:center`
 * makes the flatten `provably-safe` — but ONLY when the child's NEW parent is a statically-known grid
 * that lets the wrapper fill its area (the ONE context where the child's `justify-self` is honored).
 */

import { definePattern } from '@domflax/pattern-kit';

/**
 * Flatten a grid-centering `<div>` wrapper into its sole element child, granting the child
 * `place-self:center`.
 */
export const gridCenterWrapper = definePattern({
  name: 'grid-center-wrapper',
  category: 'flatten/grid/grid-center-wrapper',
  safety: 2,
  doc: {
    title: 'Flatten grid-centering wrapper',
    summary:
      'A div that only centers a single child (display:grid; align-items:center; ' +
      'justify-content:center) is removed; the child gains place-self:center.',
    before: '<div style="display:grid;align-items:center;justify-content:center"><Child/></div>',
    after: '<Child style="place-self:center"/>',
    safetyRationale:
      'Wrapper paints nothing, carries no ref/handlers/dynamic children, and is not a combinator ' +
      'subject; inheritable styles are folded onto the child before removal. The place-self:center ' +
      'collapse is committed by the gate only under a statically-known filling grid parent.',
  },
  match: {
    tag: 'div',
    style: { display: 'grid', alignItems: 'center', justifyContent: 'center' },
    onlyChild: 'element',
    paintsNothing: true,
  },
  rewrite: {
    flattenInto: 'child',
    childGains: { placeSelf: 'center' },
  },
  // Like `flex-center-wrapper`, collapsing to `place-self:center` is render-identical ONLY when the
  // child's NEW parent is a statically-known GRID that lets the wrapper fill its area (there both halves
  // of place-self take effect). Under that ONE context the flatten is `provably-safe` and commits; under
  // a flex/block/unknown parent — or when the wrapper drops any own style — it stays `needs-verification`
  // and the conservative production gate PRESERVES it. Op-level correctness is asserted by the invariant suite.
  test: {
    cases: [
      {
        name: 'grid parent → flattened (child gains place-self-center)',
        before:
          '<div className="grid">' +
          '<div className="grid items-center justify-center"><span className="bg-red-200">x</span></div>' +
          '</div>',
        after: '<div className="grid"><span className="bg-red-200 place-self-center">x</span></div>',
      },
    ],
    noMatch: [
      // Non-grid (document-root) parent: justify-self is ignored outside a grid → not provably safe.
      '<div className="grid justify-center items-center"><div className="bg-red-200">Hello</div></div>',
      // Grid parent, but the wrapper drops padding when removed → not layout-neutral, preserved.
      '<div className="grid">' +
        '<div className="p-4 grid items-center justify-center"><span className="bg-red-200">x</span></div>' +
        '</div>',
      // onClick is a hard opacity barrier → the wrapper is load-bearing regardless of the gate.
      '<div className="grid justify-center items-center" onClick={handleClick}>' +
        '<div className="bg-red-200">Hello</div>' +
        '</div>',
    ],
  },
});
