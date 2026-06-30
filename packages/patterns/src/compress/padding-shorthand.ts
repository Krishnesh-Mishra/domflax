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
 * Authored with the declarative {@link pattern} API: the `where` guards exclude opacity barriers,
 * dynamic class lists, spread/component identity, and combinator subjects; the `rewriteClasses`
 * recipe rebuilds the class StyleMap, declining (`null`) unless the four sides fold cleanly.
 */

import type {
  ConditionKey,
  CssProperty,
  CssValue,
  DeepReadonly,
  IRElement,
  IRNode,
  NodeLike,
  StyleBlock,
  StyleDecl,
  StyleMap,
} from '@domflax/core';
import { BASE_CONDITION, conditionKey } from '@domflax/core';

import {
  hasDynamicChildren,
  hasDynamicClasses,
  hasEventHandlers,
  hasRef,
  not,
  pattern,
  targetedByCombinator,
  type Matcher,
} from '@domflax/pattern-kit';

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

/* ───────────────────────── match guards ───────────────────────── */

/** Element carries no hard opacity barrier that rewriting its class list could disturb. */
const isInert: Matcher = (node) => {
  const n = node as DeepReadonly<IRNode>;
  if (n.kind !== 'element') return false;
  const el = n as DeepReadonly<IRElement>;
  return !el.meta.hasDangerousHtml && !el.meta.hasSpreadAttrs && !el.isComponent;
};

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
export const paddingShorthand = pattern({
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
      'A value-preserving re-serialization of the same computed styles on the same node; it skips ' +
      'nodes with ref/handlers/dynamic children/dynamic classes/dangerous html and combinator ' +
      'subjects, so no JS identity, behaviour, or project selector is disturbed.',
  },
  match: {
    where: [
      not(hasRef),
      not(hasEventHandlers),
      not(hasDynamicChildren),
      not(hasDynamicClasses),
      not(targetedByCombinator),
      isInert,
    ],
  },
  rewrite: {
    rewriteClasses(computed: StyleMap): StyleMap | null {
      const fold = analyzePadding(computed);
      return fold ? withFoldedPadding(computed, fold) : null;
    },
  },
  examples: [
    {
      // The four equal padding longhands collapse to a `padding` shorthand at the IR level (verified
      // by the invariant suite). The JSX round-trip is output-identity: the Tailwind resolver's
      // reverse-emit index is keyed on longhands and is append-only, so a raw `padding` shorthand
      // key maps to no utility.
      before: '<div className="pt-4 pr-4 pb-4 pl-4 bg-red-200">box</div>',
      after: '<div className="pt-4 pr-4 pb-4 pl-4 bg-red-200">box</div>',
    },
    {
      // Asymmetric padding (top != bottom) cannot fold into a shorthand.
      noMatch: '<div className="pt-2 pr-4 pb-8 pl-4 bg-red-200">box</div>',
    },
  ],
});
