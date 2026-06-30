/**
 * @domflax/patterns — compress pattern: `margin-shorthand`.
 *
 * Collapses the four explicit margin longhands
 *
 *   margin-top / margin-right / margin-bottom / margin-left
 *
 * back into a single CSS `margin` shorthand declaration on the SAME element (the margin analogue of
 * `padding-shorthand`, covering the `m` / `mx` / `my` collapse), choosing the shortest legal
 * 1–4-value form:
 *
 *   • all four equal               → `margin: <v>`           (the `m` case)
 *   • top==bottom and left==right  → `margin: <y> <x>`       (the `my`/`mx` case)
 *   • left==right (top!=bottom)    → `margin: <t> <x> <b>`
 *   • otherwise                    → `margin: <t> <r> <b> <l>`
 *
 * It is a pure representation change: the resolved box model is identical, only the declaration
 * count shrinks from four to one, which the backend can then re-emit as a single shorthand utility.
 *
 * Authored with the declarative {@link pattern} API: the `where` guards exclude opacity barriers,
 * dynamic class lists, and combinator subjects; the `rewriteClasses` recipe rebuilds the class
 * StyleMap, declining (`null`) unless all four margin longhands are present with a uniform
 * (non-)`!important` flag.
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
  definePattern,
  targetedByCombinator,
  type Matcher,
} from '@domflax/pattern-kit';

/* ───────────────────────── constants / helpers ───────────────────────── */

/** The four margin longhands, in CSS shorthand order (top, right, bottom, left). */
const MARGIN_SIDES = [
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
] as const satisfies readonly string[];

const MARGIN_SIDE_SET: ReadonlySet<string> = new Set(MARGIN_SIDES);

const BASE_KEY: ConditionKey = conditionKey(BASE_CONDITION);

function asElement(node: NodeLike): DeepReadonly<IRElement> | null {
  const n = node as DeepReadonly<IRNode>;
  return n.kind === 'element' ? (n as DeepReadonly<IRElement>) : null;
}

/** Raw-html opacity barrier — no combinator exposes this, so narrow + read the meta flag locally. */
const hasDangerousHtml: Matcher = (node) => asElement(node)?.meta.hasDangerousHtml ?? false;

/** Collapse four side values into the shortest legal CSS `margin` shorthand value string. */
function collapseMarginValue(top: string, right: string, bottom: string, left: string): string {
  if (right === left) {
    if (top === bottom) {
      return top === right ? top : `${top} ${right}`;
    }
    return `${top} ${right} ${bottom}`;
  }
  return `${top} ${right} ${bottom} ${left}`;
}

/** Rebuild the computed StyleMap with the four BASE-block margin longhands replaced by `margin`. */
function withFoldedMargin(sm: StyleMap, marginDecl: StyleDecl): StyleMap {
  const blocks = new Map<ConditionKey, StyleBlock>();
  for (const [key, block] of sm.blocks) {
    if (key !== BASE_KEY) {
      blocks.set(key, block);
      continue;
    }
    const decls = new Map<CssProperty, StyleDecl>();
    for (const [prop, decl] of block.decls) {
      if (!MARGIN_SIDE_SET.has(String(prop))) decls.set(prop, decl);
    }
    decls.set(marginDecl.property, marginDecl);
    blocks.set(key, { condition: block.condition, decls });
  }
  return { blocks };
}

/* ───────────────────────── the pattern ───────────────────────── */

/**
 * Fold four margin longhands into one `margin` shorthand on the element's base style block.
 */
export const marginShorthand = definePattern({
  name: 'margin-shorthand',
  category: 'compress/margin-shorthand',
  safety: 2,
  doc: {
    title: 'Compress margin longhands into the `margin` shorthand',
    summary:
      'An element with margin-top/right/bottom/left all set has them collapsed into the shortest ' +
      'legal `margin` shorthand (the m / mx / my forms); meaning is preserved, declaration count drops.',
    before: '<div style="margin-top:8px;margin-right:8px;margin-bottom:8px;margin-left:8px"/>',
    after: '<div style="margin:8px"/>',
    safetyRationale:
      'Pure representation change (no pixels move); skips nodes with ref/handlers/dynamic children/' +
      'raw html, dynamic class segments, or combinator-subject selectors.',
  },
  match: {
    where: [
      not(hasRef),
      not(hasEventHandlers),
      not(hasDynamicChildren),
      not(hasDynamicClasses),
      not(hasDangerousHtml),
      not(targetedByCombinator),
    ],
  },
  rewrite: {
    rewriteClasses(computed: StyleMap): StyleMap | null {
      const base = computed.blocks.get(BASE_KEY);
      if (!base) return null;

      // Require all four longhands present in the base block (the `m` collapse only touches base).
      const sides = MARGIN_SIDES.map((p) => base.decls.get(p as CssProperty));
      if (sides.some((d) => d === undefined)) return null;
      const [mt, mr, mb, ml] = sides as readonly StyleDecl[];

      // A shorthand can only carry a uniform `!important`; mixing would change cascade behaviour.
      if (mt.important || mr.important || mb.important || ml.important) return null;

      const value = collapseMarginValue(
        String(mt.value),
        String(mr.value),
        String(mb.value),
        String(ml.value),
      );

      const marginDecl: StyleDecl = {
        property: 'margin' as CssProperty,
        value: value as CssValue,
        important: false,
        relativeToParent:
          mt.relativeToParent || mr.relativeToParent || mb.relativeToParent || ml.relativeToParent,
        inherited: false, // margin is not an inherited property
      };

      return withFoldedMargin(computed, marginDecl);
    },
  },
  test: {
    cases: [
      {
        // The four equal margin longhands collapse to a `margin` shorthand at the IR level, and the
        // minimizing reverse-emit picks the single shortest utility (`m-2`) reproducing it, replacing
        // the four `m{t,r,b,l}-2` tokens. `bg-red-200` is preserved.
        before: '<div className="mt-2 mr-2 mb-2 ml-2 bg-red-200">box</div>',
        after: '<div className="bg-red-200 m-2">box</div>',
      },
    ],
    // Only two margin sides set → the four-longhand `margin` collapse does not apply.
    noMatch: ['<div className="mt-2 mb-2 bg-red-200">box</div>'],
  },
});
