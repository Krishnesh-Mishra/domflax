/**
 * @domflax/patterns — flatten pattern: `transform-none-wrapper`.
 *
 * Collapses a paint-free wrapper that pins `transform:none` — the initial value, which is inert:
 *
 *   <div style="transform:none"><Child/></div>   →   <Child/>
 *
 * `transform:none` applies no geometric transform and — crucially — establishes NO stacking context and
 * NO containing block for fixed/absolute descendants (a non-`none` transform would do both). A wrapper
 * whose only distinguishing declaration is `transform:none` is therefore a plain flow box and can be
 * unwrapped into its sole child. (Tailwind's `transform-none`, or a reset re-asserting the default, is
 * the usual source.)
 *
 * The flatten-safety classifier treats `transform:none` as inert (skipped by both the context and the
 * drop-own-style checks), so this flatten is `provably-safe` and commits under the conservative gate. A
 * NON-none transform establishes a stacking context / containing block, so the gate reverts those —
 * this pattern only ever proposes the `none` case.
 */

import { definePattern } from '@domflax/pattern-kit';

/**
 * Flatten a paint-free `transform:none` wrapper into its sole element child.
 */
export const transformNoneWrapper = definePattern({
  name: 'transform-none-wrapper',
  category: 'flatten/layout/transform-none-wrapper',
  safety: 2,
  doc: {
    title: 'Flatten transform:none wrapper',
    summary:
      'A paint-free wrapper whose distinguishing declaration is the inert initial value ' +
      'transform:none, wrapping a single child, is removed; the child is hoisted in its place.',
    before: '<div style="transform:none"><Child/></div>',
    after: '<Child/>',
    safetyRationale:
      'transform:none is the initial value: it applies no transform and establishes no ' +
      'stacking-context/containing-block, so removing the box changes nothing. The wrapper paints ' +
      'nothing and is guarded by the auto-applied opacity-barrier + selector-safety set; the ' +
      'flatten-safety gate reverts any wrapper carrying a non-none transform.',
  },
  match: {
    tag: 'div',
    style: { transform: 'none' },
    onlyChild: 'element',
    paintsNothing: true,
  },
  rewrite: { flattenInto: 'child' },
  test: {
    cases: [
      {
        // transform:none is inert → a provably-safe flatten: the wrapper is removed, the child hoisted.
        before: '<div className="transform-none"><span className="bg-red-200">x</span></div>',
        after: '<span className="bg-red-200">x</span>',
      },
    ],
    noMatch: [
      // A real transform establishes a stacking context / containing block, so the gate reverts the
      // unwrap and the wrapper is left unchanged.
      '<div className="rotate-45"><span className="bg-red-200">x</span></div>',
    ],
  },
});
