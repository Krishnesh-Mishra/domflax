/**
 * @domflax/patterns — compress pattern: `border-shorthand`.
 *
 * Collapses an element whose four border-side WIDTHS are expressed as separate longhand declarations
 * back into the shortest equivalent `border-width` shorthand:
 *
 *   border-top-width:2px; border-right-width:2px; border-bottom-width:2px; border-left-width:2px
 *     ⇒  border-width:2px                      (Tailwind `border-2`)
 *
 *   border-top-width:2px; border-bottom-width:2px; border-left-width:4px; border-right-width:4px
 *     ⇒  border-width:2px 4px                  (Tailwind `border-y-2 border-x-4`)
 *
 * Tailwind's per-side / per-axis width utilities (`border-t-*`, `border-x-*`, …) each resolve to the
 * matching `border-*-width` longhand(s); the shared normalizer keeps them longhand. This pass runs
 * the expansion in reverse on the computed map ONLY when the four widths fold cleanly into a 1- or
 * 2-value form — i.e. `top===bottom` AND `left===right`. Rebuilding the map with one `border-width`
 * shorthand lets the minimizing reverse-emit pick the single/paired utility (`border-2`, or
 * `border-x-* border-y-*`) instead of four per-side tokens. Only WIDTH is folded — border style and
 * color are independent longhands the resolver carries separately, so this never disturbs them.
 *
 * Authored with the declarative {@link pattern} API: the `where` guards exclude opacity barriers,
 * dynamic class lists, spread/component identity, and combinator subjects; the `rewriteClasses`
 * recipe rebuilds the class StyleMap, declining (`null`) unless the four widths fold cleanly.
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

/* ───────────────────────── border-width analysis ───────────────────────── */

/** The four border-width longhands, in CSS shorthand order: top, right, bottom, left. */
const WIDTH_SIDES = [
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
] as const satisfies readonly string[];

const WIDTH_SIDE_SET: ReadonlySet<string> = new Set<string>(WIDTH_SIDES);

const BASE_KEY: ConditionKey = conditionKey(BASE_CONDITION);

const BORDER_WIDTH = 'border-width' as CssProperty;

/** The collapsed shorthand the four widths fold into (carrying important / relative-unit flags). */
interface WidthFold {
  readonly value: string; // 1-value (`2px`) or 2-value (`2px 4px`) form
  readonly important: boolean;
  readonly relative: boolean;
}

/**
 * Inspect the BASE-condition block of `sm` and, iff all four border-width longhands are present,
 * share a uniform `!important` flag, and form matching x/y pairs (`top===bottom` AND `left===right`),
 * return the shortest equivalent shorthand value. Returns `null` when the sides cannot fold.
 */
function analyzeWidth(sm: StyleMap): WidthFold | null {
  const block = sm.blocks.get(BASE_KEY);
  if (!block) return null;

  const sides: StyleDecl[] = [];
  for (const side of WIDTH_SIDES) {
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

  // Only the `border-*` (all equal) and `border-x-* border-y-*` (matching pairs) shapes are in scope.
  if (tv !== bv || lv !== rv) return null;

  const value = tv === lv ? tv : `${tv} ${lv}`;
  const relative = sides.some((d) => d.relativeToParent);
  return { value, important: top.important, relative };
}

/* ───────────────────────── match guards ───────────────────────── */

function asElement(node: NodeLike): DeepReadonly<IRElement> | null {
  const n = node as DeepReadonly<IRNode>;
  return n.kind === 'element' ? (n as DeepReadonly<IRElement>) : null;
}

/** Element carries no hard opacity barrier that rewriting its class list could disturb. */
const isInert: Matcher = (node) => {
  const el = asElement(node);
  if (!el) return false;
  return !el.meta.hasDangerousHtml && !el.meta.hasSpreadAttrs && !el.isComponent;
};

/* ───────────────────────── style rebuild ───────────────────────── */

/** Rebuild `sm` with the four BASE-block border-width longhands replaced by one shorthand. */
function withFoldedWidth(sm: StyleMap, fold: WidthFold): StyleMap {
  const blocks = new Map<ConditionKey, StyleBlock>();
  for (const [key, block] of sm.blocks) {
    if (key !== BASE_KEY) {
      blocks.set(key, block);
      continue;
    }
    const decls = new Map<CssProperty, StyleDecl>();
    for (const [prop, decl] of block.decls) {
      if (WIDTH_SIDE_SET.has(String(prop))) continue; // drop the four width longhands
      decls.set(prop, decl);
    }
    const shorthand: StyleDecl = {
      property: BORDER_WIDTH,
      value: fold.value as CssValue,
      important: fold.important,
      relativeToParent: fold.relative,
      inherited: false, // border-width is never inherited
    };
    decls.set(shorthand.property, shorthand);
    blocks.set(key, { condition: block.condition, decls });
  }
  return { blocks };
}

/* ───────────────────────── the pattern ───────────────────────── */

/** Compress an element's four equal/paired border-width longhands into the shortest shorthand. */
export const borderShorthand = pattern({
  name: 'border-shorthand',
  category: 'compress/border-shorthand',
  safety: 1,
  doc: {
    title: 'Collapse border-width longhands to shorthand',
    summary:
      'Equal border width on all four sides (or matching x/y pairs) expressed as separate longhand ' +
      'declarations is collapsed to the shortest equivalent border-width shorthand (border-* / ' +
      'border-x-* border-y-*).',
    before: '<div class="border-t-2 border-r-2 border-b-2 border-l-2"/>',
    after: '<div class="border-2"/>',
    safetyRationale:
      'A value-preserving re-serialization of the same computed border widths on the same node ' +
      '(style/color longhands untouched); it skips nodes with ref/handlers/dynamic children/dynamic ' +
      'classes/dangerous html and combinator subjects, so no JS identity, behaviour, or project ' +
      'selector is disturbed.',
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
      const fold = analyzeWidth(computed);
      return fold ? withFoldedWidth(computed, fold) : null;
    },
  },
  examples: [
    {
      // The four equal width longhands collapse to a `border-width` shorthand at the IR level, and the
      // minimizing reverse-emit picks the single shortest utility (`border-2`) that reproduces it,
      // replacing the four `border-{t,r,b,l}-2` tokens. `bg-red-200` is preserved.
      before: '<div className="border-t-2 border-r-2 border-b-2 border-l-2 bg-red-200">box</div>',
      after: '<div className="bg-red-200 border-2">box</div>',
    },
    {
      // Asymmetric widths (top != bottom) cannot fold into a shorthand.
      noMatch: '<div className="border-t-2 border-r-4 border-b-8 border-l-4 bg-red-200">box</div>',
    },
  ],
});
