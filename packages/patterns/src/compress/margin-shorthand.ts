/**
 * @domflax/patterns — Stage-2 compress pattern: `margin-shorthand`.
 *
 * Collapses the four explicit margin longhands
 *
 *   margin-top / margin-right / margin-bottom / margin-left
 *
 * back into a single CSS `margin` shorthand declaration on the SAME element (the margin analogue of
 * `padding-shorthand`, covering the `m` / `mx` / `my` collapse). The shared normalizer always
 * *expands* a `margin` shorthand into its four sides at parse time; this compress pass performs the
 * reverse, choosing the shortest legal 1–4-value form:
 *
 *   • all four equal               → `margin: <v>`           (the `m` case)
 *   • top==bottom and left==right  → `margin: <y> <x>`       (the `my`/`mx` case)
 *   • left==right (top!=bottom)    → `margin: <t> <x> <b>`
 *   • otherwise                    → `margin: <t> <r> <b> <l>`
 *
 * It is a pure representation change: the resolved box model is identical (the verifier sees the
 * same computed margins), only the declaration count shrinks from four to one, which the backend
 * can then re-emit as a single shorthand class/utility.
 *
 * Safety reasoning (why this is sound):
 *   • the element's margins are unchanged in MEANING — only how they're written changes, so no
 *     pixels move and nothing inheritable is touched;
 *   • we never rewrite a node carrying a hard opacity barrier (ref / event handlers / dynamic
 *     children / dangerous raw html) — its JS identity / behaviour must stay byte-identical;
 *   • we never rewrite a node whose class list has a dynamic segment (the class list is the splice
 *     target — collapsing into it could clobber an author expression);
 *   • we never rewrite a node that is the subject of a combinator selector (`>`/`+`/`~`), so no
 *     project CSS that targets this element by structure is disturbed.
 *
 * Realization: a single `setClassList` op replaces the element's computed StyleMap with one whose
 * base block has the four margin longhands swapped for the collapsed `margin` shorthand. Because the
 * applier stores the StyleMap verbatim (it does not re-normalize), the shorthand survives, and the
 * pattern is idempotent — once collapsed the four longhands are gone, so it never re-fires.
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
  not,
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

/* ───────────────────────── match predicate ───────────────────────── */

/**
 * Structural / safety guard: any element that is free of hard opacity barriers, has no dynamic
 * class segment, and is not a combinator subject. The margin-specific shape (all four longhands
 * present) is checked in `evaluate`, where the values are also read.
 */
const isSafeMarginTarget: Matcher = and(
  isElement(),
  not(hasRef),
  not(hasEventHandlers),
  not(hasDynamicChildren),
  not(hasDynamicClasses),
  not(hasDangerousHtml),
  not(targetedByCombinator),
);

/* ───────────────────────── the pattern ───────────────────────── */

/**
 * The Stage-2 margin-shorthand compress pattern: fold four margin longhands into one `margin`
 * shorthand on the element's base style block.
 */
export const marginShorthand: Pattern = definePattern({
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
  evaluate(ctx: MatchContext, rw: RewriteFactory): MatchResult | null {
    const el = ctx.node;
    if (!isSafeMarginTarget(el as unknown as NodeLike, ctx)) return null;

    const computed = ctx.computed();
    const baseKey = conditionKey(BASE_CONDITION);
    const base = computed.blocks.get(baseKey);
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

    // Rebuild the computed StyleMap: every block verbatim except base, where the four margin
    // longhands are dropped in favour of the single collapsed shorthand.
    const blocks = new Map<ConditionKey, StyleBlock>();
    for (const [key, block] of computed.blocks) {
      if (key !== baseKey) {
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

    const next: StyleMap = { blocks };

    const ops: readonly RewriteOpDraft[] = [rw.setClassList(el, next)];
    return { ops };
  },
});
