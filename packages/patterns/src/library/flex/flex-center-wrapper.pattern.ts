/**
 * @domflax/patterns — flatten pattern: `flex-center-wrapper`.
 *
 * Collapses the ubiquitous "centering wrapper" idiom
 *
 *   <div style="display:flex; align-items:center; justify-content:center"><Child/></div>
 *
 * into its sole child, pushing the centering intent down onto the child as `place-self: center`.
 * The wrapper only exists to center one element; once `place-self:center` lives on the child the
 * wrapper is pure structural noise and can go.
 *
 * Authored with the declarative {@link definePattern} API: the match is the flex-centering
 * computed-style signature on a single-element-child `<div>` that paints nothing of its own; the
 * recipe folds inheritable styles onto the child, grants it `place-self:center`, then unwraps the
 * wrapper (id-preserving). The opacity-barrier + selector-safety guards are applied automatically by
 * the `definePattern` factory for every `flatten/*` pattern.
 */

import { definePattern } from '@domflax/pattern-kit';

/**
 * Flatten a flex-centering `<div>` wrapper into its sole element child, granting the child
 * `place-self:center`.
 */
export const flexCenterWrapper = definePattern({
  name: 'flex-center-wrapper',
  category: 'flatten/flex/flex-center-wrapper',
  safety: 2,
  doc: {
    title: 'Flatten flex-centering wrapper',
    summary:
      'A div that only centers a single child (display:flex; align-items:center; ' +
      'justify-content:center) is removed; the child gains place-self:center.',
    before: '<div style="display:flex;align-items:center;justify-content:center"><Child/></div>',
    after: '<Child style="place-self:center"/>',
    safetyRationale:
      'Wrapper paints nothing, carries no ref/handlers/dynamic children, and is not a combinator ' +
      'subject; inheritable styles are folded onto the child before removal.',
  },
  match: {
    tag: 'div',
    style: { display: 'flex', alignItems: 'center', justifyContent: 'center' },
    onlyChild: 'element',
    paintsNothing: true,
  },
  rewrite: {
    flattenInto: 'child',
    childGains: { placeSelf: 'center' },
  },
  // Collapsing a flex-centering wrapper to `place-self:center` on the child is render-identical ONLY
  // when the child's NEW parent is a statically-known GRID that lets the wrapper fill its area (there
  // `place-self`'s align-self AND justify-self both take effect). Under that ONE context the flatten is
  // classified `provably-safe` and commits; under a flex/block/unknown parent — or when the wrapper
  // drops any own style — it stays `needs-verification` and the conservative production gate PRESERVES
  // it. Op-level correctness (purity, id-preserving unwrap, opacity-barrier safety) is additionally
  // asserted by the invariant suite over every pattern.
  test: {
    cases: [
      {
        name: 'grid parent → flattened (child gains place-self-center)',
        before:
          '<div className="grid">' +
          '<div className="flex items-center justify-center"><span className="bg-red-200">x</span></div>' +
          '</div>',
        after: '<div className="grid"><span className="bg-red-200 place-self-center">x</span></div>',
      },
    ],
    noMatch: [
      // Non-grid (flex) parent (document root): `justify-self` is ignored in flex → not provably safe.
      '<div className="flex justify-center items-center"><div className="bg-red-200">Hello</div></div>',
      // Grid parent, but the wrapper drops padding when removed → not layout-neutral (rule 3).
      '<div className="grid">' +
        '<div className="p-4 flex items-center justify-center"><span className="bg-red-200">x</span></div>' +
        '</div>',
      // Grid parent forcing place-items-center: the wrapper would not fill its area → fill guard skips.
      '<div className="grid place-items-center">' +
        '<div className="flex items-center justify-center"><span className="bg-red-200">x</span></div>' +
        '</div>',
      // onClick is a hard opacity barrier → the wrapper is load-bearing regardless of the gate.
      '<div className="flex justify-center items-center" onClick={handleClick}>' +
        '<div className="bg-red-200">Hello</div>' +
        '</div>',
    ],
  },
});
