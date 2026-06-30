/**
 * @domflax/patterns — compress pattern: `overflow-shorthand`.
 *
 * Collapses an element whose two overflow axes are expressed as equal longhands back into the single
 * `overflow` shorthand:
 *
 *   overflow-x:auto; overflow-y:auto   ⇒   overflow:auto   (Tailwind `overflow-x-auto overflow-y-auto`
 *                                                            → `overflow-auto`)
 *
 * Unlike the box shorthands, the shared normalizer leaves `overflow-x` / `overflow-y` as independent
 * longhands (it does not synthesize an `overflow` shorthand), so an element styled with two equal
 * axis utilities keeps two separate declarations until this pass folds them. The fold runs ONLY when
 * both axes carry the SAME value and `!important` flag; an asymmetric pair (`overflow-x !==
 * overflow-y`) has no single-keyword `overflow` equivalent and is declined.
 *
 * Authored with the declarative {@link pattern} API: the `where` guards exclude opacity barriers,
 * dynamic class lists, and combinator subjects (compress patterns get NO auto-guards); the
 * `rewriteClasses` recipe rebuilds the class StyleMap, declining (`null`) unless both overflow axes
 * are present, equal, and share an `!important` flag.
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

/* ───────────────────────── property handles ───────────────────────── */

const OVERFLOW_X = 'overflow-x' as CssProperty;
const OVERFLOW_Y = 'overflow-y' as CssProperty;
const OVERFLOW = 'overflow' as CssProperty;

const BASE_KEY: ConditionKey = conditionKey(BASE_CONDITION);

/* ───────────────────────── helpers ───────────────────────── */

function asElement(node: NodeLike): DeepReadonly<IRElement> | null {
  const n = node as DeepReadonly<IRNode>;
  return n.kind === 'element' ? (n as DeepReadonly<IRElement>) : null;
}

/** Element carries raw/dangerous HTML (e.g. dangerouslySetInnerHTML) — a hard opacity barrier. */
const hasDangerousHtml: Matcher = (node) => asElement(node)?.meta.hasDangerousHtml ?? false;

/**
 * Rebuild the computed StyleMap with the BASE block's `overflow-x`/`overflow-y` pair replaced by a
 * single `overflow` declaration; all other conditions/blocks are preserved verbatim.
 */
function withOverflowShorthand(sm: StyleMap, overflowDecl: StyleDecl): StyleMap {
  const blocks = new Map<ConditionKey, StyleBlock>();
  for (const [key, block] of sm.blocks) {
    if (key !== BASE_KEY) {
      blocks.set(key, block);
      continue;
    }
    const decls = new Map<CssProperty, StyleDecl>();
    for (const [prop, decl] of block.decls) {
      if (prop === OVERFLOW_X || prop === OVERFLOW_Y) continue; // drop the two axis longhands
      decls.set(prop, decl);
    }
    decls.set(overflowDecl.property, overflowDecl);
    blocks.set(key, { condition: block.condition, decls });
  }
  return { blocks };
}

/* ───────────────────────── the pattern ───────────────────────── */

/** Fold an equal `overflow-x`/`overflow-y` pair into the single `overflow` shorthand. */
export const overflowShorthand = pattern({
  name: 'overflow-shorthand',
  category: 'compress/overflow-shorthand',
  safety: 1,
  doc: {
    title: 'Collapse equal overflow axes into the `overflow` shorthand',
    summary:
      'An element whose computed overflow-x and overflow-y are equal has the two axis longhands ' +
      'collapsed into a single `overflow` shorthand (Tailwind overflow-x-* overflow-y-* → overflow-*).',
    before: '<div style="overflow-x:auto;overflow-y:auto"/>',
    after: '<div style="overflow:auto"/>',
    safetyRationale:
      'A single-keyword `overflow` is value-identical to equal overflow-x+overflow-y; the element ' +
      'carries no ref/handlers/dynamic children/dangerous HTML, no dynamic class segment, and is ' +
      'not a combinator subject, so neither behaviour nor any project selector is disturbed.',
  },
  match: {
    where: [
      not(hasRef),
      not(hasEventHandlers),
      not(hasDynamicChildren),
      not(hasDangerousHtml),
      not(hasDynamicClasses),
      not(targetedByCombinator),
    ],
  },
  rewrite: {
    rewriteClasses(computed: StyleMap): StyleMap | null {
      const base = computed.blocks.get(BASE_KEY);
      if (!base) return null;

      const overflowX = base.decls.get(OVERFLOW_X);
      const overflowY = base.decls.get(OVERFLOW_Y);
      if (!overflowX || !overflowY) return null;

      // The single-keyword shorthand cannot carry per-axis `!important` or differing values.
      if (overflowX.important !== overflowY.important) return null;
      if (overflowX.value !== overflowY.value) return null;

      const overflowDecl: StyleDecl = {
        property: OVERFLOW,
        value: overflowX.value as CssValue,
        important: overflowX.important,
        relativeToParent: overflowX.relativeToParent || overflowY.relativeToParent,
        inherited: false, // overflow is not an inherited property
      };
      return withOverflowShorthand(computed, overflowDecl);
    },
  },
  examples: [
    {
      // Equal overflow axes collapse to an `overflow` decl at the IR level; the minimizing
      // reverse-emit picks the single utility covering both (`overflow-auto`), replacing the
      // `overflow-x-auto`+`overflow-y-auto` pair. `bg-red-200` is preserved.
      before: '<div className="overflow-x-auto overflow-y-auto bg-red-200">box</div>',
      after: '<div className="bg-red-200 overflow-auto">box</div>',
    },
    {
      // Mismatched axes (overflow-x != overflow-y) have no single-keyword equivalent → not collapsed.
      noMatch: '<div className="overflow-x-auto overflow-y-hidden bg-red-200">box</div>',
    },
  ],
});
