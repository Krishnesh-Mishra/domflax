/**
 * @domflax/patterns — flatten pattern: `inline-flex-center-wrapper`.
 *
 * Collapses the inline-flex flavour of the "centering wrapper" idiom
 *
 *   <div style="display:inline-flex; align-items:center; justify-content:center"><Child/></div>
 *
 * into its sole child, pushing the centering intent down onto the child as `place-self: center`.
 * Like its block-level `flex-center-wrapper` sibling the wrapper only exists to center one element;
 * once `place-self:center` lives on the child the wrapper is pure structural noise and can go.
 *
 * Authored with the declarative {@link pattern} API: the match is the inline-flex-centering
 * computed-style signature on a single-element-child `<div>` that paints nothing of its own; the
 * recipe folds inheritable styles onto the child, grants it `place-self:center`, then unwraps the
 * wrapper (id-preserving). The opacity-barrier + selector-safety guards are applied automatically by
 * the `pattern()` factory for every `flatten/*` pattern.
 */

import { pattern } from '@domflax/pattern-kit';

/**
 * Flatten an inline-flex-centering `<div>` wrapper into its sole element child, granting the child
 * `place-self:center`.
 */
export const inlineFlexCenterWrapper = pattern({
  name: 'inline-flex-center-wrapper',
  category: 'flatten/inline-flex-center-wrapper',
  safety: 2,
  doc: {
    title: 'Flatten inline-flex-centering wrapper',
    summary:
      'A div that only centers a single child (display:inline-flex; align-items:center; ' +
      'justify-content:center) is removed; the child gains place-self:center.',
    before:
      '<div style="display:inline-flex;align-items:center;justify-content:center"><Child/></div>',
    after: '<Child style="place-self:center"/>',
    safetyRationale:
      'Wrapper paints nothing, carries no ref/handlers/dynamic children, and is not a combinator ' +
      'subject; inheritable styles are folded onto the child before removal.',
  },
  match: {
    tag: 'div',
    style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
    onlyChild: 'element',
    paintsNothing: true,
  },
  rewrite: {
    flattenInto: 'child',
    childGains: { placeSelf: 'center' },
  },
  examples: [
    {
      // The wrapper is removed; the surviving child gains `place-self-center` (reverse-emitted
      // from the folded computed style by the resolver).
      before:
        '<div className="inline-flex justify-center items-center">' +
        '<div className="bg-red-200">Hello</div>' +
        '</div>',
      after: '<div className="bg-red-200 place-self-center">Hello</div>',
    },
    {
      // onClick is a hard opacity barrier → the wrapper is load-bearing, no flatten.
      noMatch:
        '<div className="inline-flex justify-center items-center" onClick={handleClick}>' +
        '<div className="bg-red-200">Hello</div>' +
        '</div>',
    },
  ],
});
