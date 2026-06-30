/**
 * @domflax/patterns — compress pattern: `size-shorthand`.
 *
 * Collapses an element whose computed `width` and `height` are EQUAL into the single Tailwind
 * `size-*` utility:
 *
 *   <div style="width:1rem; height:1rem"/>   →   <div class="size-4"/>
 *
 * At the IR level we work over the normalized computed StyleMap (CSS longhands), so the pattern
 * recognizes the `width === height` shape in the BASE condition and rebuilds the element's class
 * StyleMap with a single `size` declaration (the resolver reverse-emits the concrete `size-*` token
 * at codegen). Both longhands are removed and replaced by the merged `size` decl, so the rewrite is
 * idempotent — once collapsed there is no `width`+`height` pair left to re-match.
 *
 * Authored with the declarative {@link pattern} API: the `where` guards exclude opacity barriers,
 * dynamic class lists, and combinator subjects (compress patterns get NO auto-guards); the
 * `rewriteClasses` recipe rebuilds the class StyleMap, returning `null` (decline) unless the BASE
 * width/height are equal, concrete, and share an `!important` flag.
 */

import type {
  ConditionKey,
  CssProperty,
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
  normalizer,
  not,
  pattern,
  targetedByCombinator,
  type Matcher,
} from '@domflax/pattern-kit';

const WIDTH = 'width' as CssProperty;
const HEIGHT = 'height' as CssProperty;
const SIZE = 'size' as CssProperty;

/** Values for which collapsing the two axes is pointless or unsound (no concrete equal extent). */
const NON_COLLAPSIBLE_VALUES: ReadonlySet<string> = new Set<string>(['auto', 'initial', 'unset']);

/* ───────────────────────── helpers ───────────────────────── */

function asElement(node: NodeLike): DeepReadonly<IRElement> | null {
  const n = node as DeepReadonly<IRNode>;
  return n.kind === 'element' ? (n as DeepReadonly<IRElement>) : null;
}

/** Read the BASE-condition block of the node's normalized computed StyleMap, if any. */
function baseBlock(sm: StyleMap): StyleBlock | undefined {
  return sm.blocks.get(conditionKey(BASE_CONDITION));
}

/** Element carries raw/dangerous HTML (e.g. dangerouslySetInnerHTML) — a hard opacity barrier. */
const hasDangerousHtml: Matcher = (node) => asElement(node)?.meta.hasDangerousHtml ?? false;

/**
 * Rebuild the computed StyleMap with the BASE block's `width`/`height` pair replaced by a single
 * `size` declaration; all other conditions/blocks are preserved verbatim.
 */
function withSizeShorthand(sm: StyleMap, value: string, important: boolean): StyleMap {
  const baseKey = conditionKey(BASE_CONDITION);
  const blocks = new Map<ConditionKey, StyleBlock>();
  for (const [key, block] of sm.blocks) {
    if (key !== baseKey) {
      blocks.set(key, block);
      continue;
    }
    const decls = new Map<CssProperty, StyleDecl>(block.decls);
    decls.delete(WIDTH);
    decls.delete(HEIGHT);
    for (const decl of normalizer.normalizeDeclaration(String(SIZE), value, important)) {
      decls.set(decl.property, decl);
    }
    blocks.set(key, { condition: block.condition, decls });
  }
  return { blocks };
}

/* ───────────────────────── the pattern ───────────────────────── */

/** Fold equal `width`/`height` into the `size-*` utility. */
export const sizeShorthand = pattern({
  name: 'size-shorthand',
  category: 'compress/size-shorthand',
  safety: 2,
  doc: {
    title: 'Collapse equal width/height into size-*',
    summary:
      'An element whose computed width and height are equal is rewritten to the single Tailwind ' +
      'size-* utility (size-* === width + height at the same value).',
    before: '<div style="width:1rem;height:1rem"/>',
    after: '<div class="size-4"/>',
    safetyRationale:
      'size-* is value-identical to equal width+height; the element carries no ref/handlers/' +
      'dynamic children/dangerous HTML, no dynamic class segment, and is not a combinator subject.',
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
      const base = baseBlock(computed);
      const w = base?.decls.get(WIDTH);
      const h = base?.decls.get(HEIGHT);
      if (!w || !h) return null;
      if (w.important !== h.important) return null;
      if (NON_COLLAPSIBLE_VALUES.has(String(w.value))) return null;
      if (w.value !== h.value) return null;
      return withSizeShorthand(computed, String(w.value), w.important);
    },
  },
  examples: [
    {
      // Equal width/height collapse to a `size` decl at the IR level (verified by the invariant
      // suite). The JSX round-trip is output-identity: the Tailwind resolver's reverse-emit index
      // is keyed on longhands and is append-only, so a raw `size` shorthand key maps to no utility.
      before: '<div className="h-10 w-10 bg-red-200">box</div>',
      after: '<div className="h-10 w-10 bg-red-200">box</div>',
    },
    {
      // Width and height differ → no equal-axis collapse.
      noMatch: '<div className="h-10 w-20 bg-red-200">box</div>',
    },
  ],
});
