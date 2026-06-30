/**
 * @domflax/patterns — Stage-2 compress pattern: `inset-shorthand`.
 *
 * Recompacts the four physical inset longhands (`top`/`right`/`bottom`/`left`) on an element's
 * computed style back into the tightest CSS shorthand the values allow:
 *
 *   • all four equal                       → `inset: <v>`
 *   • top == bottom  (a matching pair)     → `inset-block: <v>`   (Tailwind `inset-y-*`)
 *   • left == right  (a matching pair)     → `inset-inline: <v>`  (Tailwind `inset-x-*`)
 *
 * The two axis collapses are independent: an element whose `top == bottom` but `left != right`
 * collapses only the block axis and keeps the `left`/`right` longhands verbatim. When nothing
 * collapses (all four distinct, or fewer than a full pair present) the pattern does not match.
 *
 * This is a meaning-preserving serialization compaction: `inset`/`inset-block`/`inset-inline` are
 * the canonical CSS shorthands for exactly these longhands, so no pixel or cascade behaviour
 * changes. (The shared normalizer EXPANDS shorthands when parsing a declaration, but
 * `normalizeStyleMap` does NOT re-expand an already-built block — so the compacted block is a
 * stable fixpoint and the pass converges in one sweep.)
 *
 * Safety reasoning (why this is sound):
 *   • the element is not the subject of a combinator selector (`>`/`+`/`~`), so rewriting its
 *     resolved style cannot change which project CSS rules match it;
 *   • it carries no ref / event handlers / dynamic children / raw (dangerous) HTML — the hard
 *     opacity barriers — so no JS identity or behaviour rides on the element;
 *   • its class list is not dynamic/opaque, so the resolved style is safe to re-emit.
 *
 * Realization: a single `setClassList` op installs a rebuilt computed StyleMap — every condition
 * block is preserved untouched except the base block, whose collapsed longhands are swapped for the
 * shorthand decl(s). Non-inset declarations in the base block are carried over verbatim.
 */

import type {
  ConditionKey,
  CssProperty,
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
import { BASE_CONDITION_KEY } from '@domflax/core';

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

/* ───────────────────────── property handles ───────────────────────── */

const TOP = 'top' as CssProperty;
const RIGHT = 'right' as CssProperty;
const BOTTOM = 'bottom' as CssProperty;
const LEFT = 'left' as CssProperty;
const INSET = 'inset' as CssProperty;
const INSET_BLOCK = 'inset-block' as CssProperty; // top + bottom  (Tailwind inset-y)
const INSET_INLINE = 'inset-inline' as CssProperty; // left + right (Tailwind inset-x)

/* ───────────────────────── match predicate ───────────────────────── */

/** Element sets raw/dangerous HTML (`dangerouslySetInnerHTML`) — a hard opacity barrier. */
const hasRawHtml: Matcher = (node) => {
  const n = node as DeepReadonly<IRNode>;
  return n.kind === 'element' ? (n as DeepReadonly<IRElement>).meta.hasDangerousHtml : false;
};

/**
 * Gate: an addressable element with no opacity barrier and no CSS-selector coupling. The actual
 * "are there collapsible insets?" decision is value-relational, so it lives in `evaluate` (the
 * fixed-partial `computed()` matcher cannot express "these longhands equal each other").
 */
const isCompressibleInsetTarget: Matcher = and(
  isElement(),
  not(hasRef),
  not(hasEventHandlers),
  not(hasDynamicChildren),
  not(hasRawHtml),
  not(hasDynamicClasses),
  not(targetedByCombinator),
);

/* ───────────────────────── value helpers ───────────────────────── */

/** Two side-decls collapse only if they agree on BOTH normalized value and `!important`. */
function sameSide(a: StyleDecl | undefined, b: StyleDecl | undefined): boolean {
  return a !== undefined && b !== undefined && a.value === b.value && a.important === b.important;
}

/** Re-key a decl onto a new property, recomputing its inherited flag for that property. */
function asProperty(src: StyleDecl, property: CssProperty): StyleDecl {
  return { ...src, property, inherited: normalizer.inherited.isInherited(property) };
}

/** Rebuild `src` with the base block's decls replaced; all other condition blocks pass through. */
function withBaseDecls(src: StyleMap, baseDecls: ReadonlyMap<CssProperty, StyleDecl>): StyleMap {
  const blocks = new Map<ConditionKey, StyleBlock>();
  for (const [key, block] of src.blocks) {
    const decls =
      key === BASE_CONDITION_KEY
        ? baseDecls
        : new Map<CssProperty, StyleDecl>(block.decls);
    blocks.set(key, { condition: block.condition, decls });
  }
  return { blocks };
}

/* ───────────────────────── the pattern ───────────────────────── */

/**
 * The one Stage-2 compress pattern: collapse equal/paired physical inset longhands into the
 * `inset` / `inset-block` / `inset-inline` shorthands on an element's computed style.
 */
export const insetShorthand: Pattern = definePattern({
  name: 'inset-shorthand',
  category: 'compress/inset-shorthand',
  safety: 2,
  doc: {
    title: 'Compress inset longhands into a shorthand',
    summary:
      'top/right/bottom/left set to one value collapse to `inset`; a matching top/bottom or ' +
      'left/right pair collapses to `inset-block` / `inset-inline` (Tailwind inset-y / inset-x).',
    before: '<div style="top:10px;right:10px;bottom:10px;left:10px"/>',
    after: '<div style="inset:10px"/>',
    safetyRationale:
      'Meaning-preserving shorthand compaction; the element is not a combinator subject and carries ' +
      'no ref/handlers/dynamic children/raw HTML, so neither selector matching nor behaviour changes.',
  },
  evaluate(ctx: MatchContext, rw: RewriteFactory): MatchResult | null {
    const el = ctx.node;
    if (!isCompressibleInsetTarget(el as unknown as NodeLike, ctx)) return null;

    const computed = ctx.computed();
    const base = computed.blocks.get(BASE_CONDITION_KEY);
    if (!base) return null;

    const top = base.decls.get(TOP);
    const right = base.decls.get(RIGHT);
    const bottom = base.decls.get(BOTTOM);
    const left = base.decls.get(LEFT);

    const next = new Map<CssProperty, StyleDecl>(base.decls);

    // 1. All four sides equal → single `inset`.
    if (top && sameSide(top, right) && sameSide(top, bottom) && sameSide(top, left)) {
      next.delete(TOP);
      next.delete(RIGHT);
      next.delete(BOTTOM);
      next.delete(LEFT);
      next.set(INSET, asProperty(top, INSET));
    } else {
      let collapsed = false;
      // 2a. Block axis: top == bottom → `inset-block`.
      if (sameSide(top, bottom)) {
        next.delete(TOP);
        next.delete(BOTTOM);
        next.set(INSET_BLOCK, asProperty(top!, INSET_BLOCK));
        collapsed = true;
      }
      // 2b. Inline axis: left == right → `inset-inline`.
      if (sameSide(left, right)) {
        next.delete(LEFT);
        next.delete(RIGHT);
        next.set(INSET_INLINE, asProperty(left!, INSET_INLINE));
        collapsed = true;
      }
      if (!collapsed) return null; // nothing to compress — no-op
    }

    const ops: readonly RewriteOpDraft[] = [
      rw.setClassList(el, withBaseDecls(computed, next)),
    ];
    return { ops };
  },
});
