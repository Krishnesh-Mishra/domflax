/**
 * @domflax/patterns — compress pattern: `padding-shorthand`.
 *
 * Collapses an element whose four padding sides are expressed as separate longhand declarations
 * back into the shortest equivalent shorthand:
 *
 *   padding-top:16px; padding-right:16px; padding-bottom:16px; padding-left:16px
 *     ⇒  padding:16px                         (Tailwind `p-4`)
 *
 *   padding-top:8px; padding-bottom:8px; padding-left:16px; padding-right:16px
 *     ⇒  padding:8px 16px                     (Tailwind `px-4 py-2`)
 *
 * The IR's computed StyleMap is canonically LONGHAND (the shared normalizer expands every box
 * shorthand at parse time). This pass runs the expansion in reverse on the computed map ONLY when
 * the four sides fold cleanly into a 1- or 2-value form — i.e. `top===bottom` AND `left===right`.
 *
 * Authored with the declarative {@link pattern} API: `definePattern` auto-applies the compress safety guards — a dynamic or opaque class list
 * and combinator-subject selectors are excluded (a ref / event handler / dynamic child / dangerous
 * HTML never blocks a class-only rewrite); the `rewriteClasses`
 * recipe rebuilds the class StyleMap, declining (`null`) unless the four sides fold cleanly.
 */

import type { ConditionKey, CssProperty, CssValue, StyleBlock, StyleDecl, StyleMap } from '@domflax/core';
import { BASE_CONDITION, conditionKey } from '@domflax/core';

import { definePattern } from '@domflax/pattern-kit';

/* ───────────────────────── padding analysis ───────────────────────── */

/** The four padding longhands, in CSS shorthand order: top, right, bottom, left. */
const PADDING_SIDES = [
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
] as const;

const PADDING_SIDE_SET: ReadonlySet<string> = new Set<string>(PADDING_SIDES);

const BASE_KEY: ConditionKey = conditionKey(BASE_CONDITION);

/** The collapsed shorthand the four sides fold into (carrying important / relative-unit flags). */
interface PaddingFold {
  readonly value: string; // 1-value (`16px`) or 2-value (`8px 16px`) form
  readonly important: boolean;
  readonly relative: boolean;
}

/**
 * Inspect the BASE-condition block of `sm` and, iff all four padding longhands are present, share a
 * uniform `!important` flag, and form matching x/y pairs (`top===bottom` AND `left===right`), return
 * the shortest equivalent shorthand value. Returns `null` when the sides cannot fold.
 */
function analyzePadding(sm: StyleMap): PaddingFold | null {
  const block = sm.blocks.get(BASE_KEY);
  if (!block) return null;

  const sides: StyleDecl[] = [];
  for (const side of PADDING_SIDES) {
    const decl = block.decls.get(side as CssProperty);
    if (!decl) return null;
    sides.push(decl);
  }
  const [top, right, bottom, left] = sides as [StyleDecl, StyleDecl, StyleDecl, StyleDecl];

  // A shorthand cannot carry per-side `!important`; only fold a uniform flag.
  if (
    !(
      top.important === right.important &&
      right.important === bottom.important &&
      bottom.important === left.important
    )
  ) {
    return null;
  }

  const tv = String(top.value);
  const rv = String(right.value);
  const bv = String(bottom.value);
  const lv = String(left.value);

  // Only the `p-*` (all equal) and `px-* py-*` (matching pairs) shapes are in scope.
  if (tv !== bv || lv !== rv) return null;

  const value = tv === lv ? tv : `${tv} ${lv}`;
  const relative = sides.some((d) => d.relativeToParent);
  return { value, important: top.important, relative };
}

/* ───────────────────────── style rebuild ───────────────────────── */

/** Rebuild `sm` with the four BASE-block padding longhands replaced by one `padding` shorthand. */
function withFoldedPadding(sm: StyleMap, fold: PaddingFold): StyleMap {
  const blocks = new Map<ConditionKey, StyleBlock>();
  for (const [key, block] of sm.blocks) {
    if (key !== BASE_KEY) {
      blocks.set(key, block);
      continue;
    }
    const decls = new Map<CssProperty, StyleDecl>();
    for (const [prop, decl] of block.decls) {
      if (PADDING_SIDE_SET.has(String(prop))) continue; // drop the four longhands
      decls.set(prop, decl);
    }
    const shorthand: StyleDecl = {
      property: 'padding' as CssProperty,
      value: fold.value as CssValue,
      important: fold.important,
      relativeToParent: fold.relative,
      inherited: false, // padding is never inherited
    };
    decls.set(shorthand.property, shorthand);
    blocks.set(key, { condition: block.condition, decls });
  }
  return { blocks };
}

/* ───────────────────────── the pattern ───────────────────────── */

/**
 * Compress an element's four equal/paired padding longhands into the shortest `padding` shorthand.
 */
export const paddingShorthand = definePattern({
  name: 'padding-shorthand',
  category: 'compress/padding-shorthand',
  safety: 1,
  doc: {
    title: 'Collapse padding longhands to shorthand',
    summary:
      'Equal padding on all four sides (or matching x/y pairs) expressed as separate longhand ' +
      'declarations is collapsed to the shortest equivalent padding shorthand (p-* / px-* py-*).',
    before: '<div class="pt-4 pr-4 pb-4 pl-4"/>',
    after: '<div class="p-4"/>',
    safetyRationale:
      'A value-preserving re-serialization of the same computed padding on the same node — a class-only ' +
      'change. It is safe even on an element with a ref, event handler, dynamic child, or ' +
      'dangerouslySetInnerHTML — a className rewrite touches none of them; only a dynamic/opaque class ' +
      'list or a combinator-subject class is excluded, so no behaviour or project selector is disturbed.',
  },
  rewrite: {
    rewriteClasses(computed: StyleMap): StyleMap | null {
      const fold = analyzePadding(computed);
      return fold ? withFoldedPadding(computed, fold) : null;
    },
  },
  test: {
    cases: [
      {
        // The four equal padding longhands collapse to a `padding` shorthand at the IR level, and the
        // minimizing reverse-emit picks the single shortest utility (`p-4`) that reproduces it,
        // replacing the four `p{t,r,b,l}-4` tokens. `bg-red-200` is preserved (its order is stable).
        before: '<div className="pt-4 pr-4 pb-4 pl-4 bg-red-200">box</div>',
        after: '<div className="bg-red-200 p-4">box</div>',
      },
      {
        // A dynamic `{x}` child no longer blocks compress: only the element's OWN class tokens are
        // rewritten (px-4 py-4 → p-4); the dynamic child is untouched by a class-only change. This is
        // the real-app common case (most elements have dynamic content).
        before: '<div className="px-4 py-4">{x}</div>',
        after: '<div className="p-4">{x}</div>',
      },
    ],
    // Asymmetric padding (top != bottom) cannot fold into a shorthand → left unchanged.
    noMatch: ['<div className="pt-2 pr-4 pb-8 pl-4 bg-red-200">box</div>'],
  },
});
