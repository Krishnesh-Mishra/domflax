/**
 * @domflax/patterns — Stage-2 compress pattern: `size-shorthand`.
 *
 * Collapses an element whose computed `width` and `height` are EQUAL into the single Tailwind
 * `size-*` utility:
 *
 *   <div style="width:1rem; height:1rem"/>   →   <div class="size-4"/>
 *
 * At the IR level we work over the normalized computed StyleMap (CSS longhands), so the pattern
 * recognizes the `width === height` shape in the BASE condition and rewrites the element's class
 * source to a single `size` declaration (the resolver reverse-emits the concrete `size-*` token at
 * codegen). Both longhands are removed and replaced by the merged `size` decl, so the rewrite is
 * idempotent — once collapsed there is no `width`+`height` pair left to re-match.
 *
 * Safety reasoning (why this is sound):
 *   • `size-*` is exactly `width` + `height` set to the same value, so the collapse is value-
 *     preserving — no pixels change;
 *   • we never touch an element carrying a ref / event handlers / dynamic children / dangerous HTML
 *     (hard opacity barriers), nor one whose class list has a dynamic segment (not splice-safe),
 *     nor one that is the subject of a combinator selector (`>`/`+`/`~`) whose project CSS could be
 *     keyed off the original utilities;
 *   • only equal, concrete values are folded; an `auto` axis or a width/height mismatch leaves the
 *     element untouched.
 *
 * Realization: a single `setClassList` op installs the rewritten StyleMap (the only op that can drop
 * the original `width`/`height` longhands while introducing `size`). Non-base conditions are copied
 * through verbatim.
 */

import type {
  ConditionKey,
  CssProperty,
  CssValue,
  DeepReadonly,
  IRElement,
  IRNode,
  MatchContext,
  MatchResult,
  NodeLike,
  Pattern,
  RewriteFactory,
  RewriteOpDraft,
  StyleBlock,
  StyleDecl,
  StyleMap,
} from '@domflax/core';
import { BASE_CONDITION, conditionKey } from '@domflax/core';

import {
  and,
  definePattern,
  hasDynamicChildren,
  hasDynamicClasses,
  hasEventHandlers,
  hasRef,
  isElement,
  normalizer,
  not,
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

/* ───────────────────────── match predicate ───────────────────────── */

/** Element carries raw/dangerous HTML (e.g. dangerouslySetInnerHTML) — a hard opacity barrier. */
const hasDangerousHtml: Matcher = (node) => asElement(node)?.meta.hasDangerousHtml ?? false;

/**
 * Element's BASE-condition computed style sets `width` and `height` to the SAME concrete value.
 * Comparison is over the normalized values, so `1rem`/`1rem` matches but `1rem`/`16px` does not.
 */
const hasEqualSizeAxes: Matcher = (node, ctx) => {
  const el = asElement(node);
  if (!el) return false;
  const sm = ctx.computedOf(node) ?? (el.computed as StyleMap);
  const base = baseBlock(sm as StyleMap);
  if (!base) return false;
  const w = base.decls.get(WIDTH);
  const h = base.decls.get(HEIGHT);
  if (!w || !h) return false;
  if (w.important !== h.important) return false;
  if (NON_COLLAPSIBLE_VALUES.has(String(w.value))) return false;
  return w.value === h.value;
};

const isCollapsibleSizeBox: Matcher = and(
  isElement(),
  hasEqualSizeAxes,
  not(hasRef),
  not(hasEventHandlers),
  not(hasDynamicChildren),
  not(hasDangerousHtml),
  not(hasDynamicClasses),
  not(targetedByCombinator),
);

/* ───────────────────────── the pattern ───────────────────────── */

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

/** The one Stage-2 compress pattern: fold equal `width`/`height` into the `size-*` utility. */
export const sizeShorthand: Pattern = definePattern({
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
  evaluate(ctx: MatchContext, rw: RewriteFactory): MatchResult | null {
    const node = ctx.node;
    if (!isCollapsibleSizeBox(node as unknown as NodeLike, ctx)) return null;

    const sm = ctx.computed();
    const base = baseBlock(sm);
    const w = base?.decls.get(WIDTH);
    if (!w) return null; // guarded by the matcher; satisfies the type-narrowing too

    const next = withSizeShorthand(sm, String(w.value as CssValue), w.important);
    const ops: readonly RewriteOpDraft[] = [rw.setClassList(node, next, true)];
    return { ops };
  },
});
