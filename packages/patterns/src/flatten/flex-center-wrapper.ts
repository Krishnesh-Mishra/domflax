/**
 * @domflax/patterns — Stage-1 flatten pattern: `flex-center-wrapper`.
 *
 * Collapses the ubiquitous "centering wrapper" idiom
 *
 *   <div style="display:flex; align-items:center; justify-content:center"><Child/></div>
 *
 * into its sole child, pushing the centering intent down onto the child as `place-self: center`.
 * The wrapper only exists to center one element; once `place-self:center` lives on the child the
 * wrapper is pure structural noise and can go.
 *
 * Safety reasoning (why this is sound):
 *   • the wrapper paints nothing of its own (`hasOwnVisualStyle` is false across every condition),
 *     so removing its box loses no pixels;
 *   • it carries no ref / event handlers / dynamic children (hard opacity barriers), so no JS
 *     identity or behaviour is attached to the wrapper element;
 *   • it is not the subject of a combinator selector (`>`/`+`/`~`), so no project CSS targets it;
 *   • inheritable declarations on the wrapper are folded onto the child first, so inherited values
 *     (color, font, …) survive the box removal.
 *
 * Realization: "replace the wrapper with the child" is performed with the structural-safe `unwrap`
 * op — for a single-element-child wrapper, unwrapping splices the child into the wrapper's slot and
 * deletes ONLY the wrapper node, preserving the child's `IRNodeId` (invariant D10). (`replaceWith`
 * + a `keep(child)` ref cannot be used here: the core applier's `replaceWith` calls `removeSubtree`
 * on the wrapper, which would also delete the still-parented child.)
 */

import type {
  ConditionKey,
  CssProperty,
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
  computed,
  definePattern,
  hasDynamicChildren,
  hasEventHandlers,
  hasOwnVisualStyle,
  hasRef,
  hasSingleElementChild,
  isElement,
  normalizer,
  not,
  targetedByCombinator,
  type Matcher,
} from '@domflax/pattern-kit';

/* ───────────────────────── style fixtures ───────────────────────── */

/** Build a single-(base-)condition StyleMap from raw `[property, value]` pairs via the shared normalizer. */
function baseConditionStyleMap(decls: readonly (readonly [string, string])[]): StyleMap {
  const map = new Map<CssProperty, StyleDecl>();
  for (const [prop, value] of decls) {
    for (const decl of normalizer.normalizeDeclaration(prop, value, false)) {
      map.set(decl.property, decl);
    }
  }
  const block: StyleBlock = { condition: BASE_CONDITION, decls: map };
  const blocks = new Map<ConditionKey, StyleBlock>([[conditionKey(BASE_CONDITION), block]]);
  return { blocks };
}

/** The flex-centering signature the wrapper's computed style must be a superset of. */
const FLEX_CENTER: StyleMap = baseConditionStyleMap([
  ['display', 'flex'],
  ['align-items', 'center'],
  ['justify-content', 'center'],
]);

/** The intent pushed onto the surviving child: center it within its (new) container. */
const PLACE_SELF_CENTER: StyleMap = baseConditionStyleMap([['place-self', 'center']]);

/* ───────────────────────── match predicate ───────────────────────── */

const isFlexCenterWrapper: Matcher = and(
  isElement('div'),
  computed(FLEX_CENTER),
  hasSingleElementChild,
  not(hasOwnVisualStyle),
  not(hasRef),
  not(hasEventHandlers),
  not(hasDynamicChildren),
  not(targetedByCombinator),
);

/* ───────────────────────── the pattern ───────────────────────── */

/**
 * The one Stage-1 pattern: flatten a flex-centering `<div>` wrapper into its sole element child.
 */
export const flexCenterWrapper: Pattern = definePattern({
  name: 'flex-center-wrapper',
  category: 'flatten/flex-center-wrapper',
  safety: 2,
  doc: {
    title: 'Flatten flex-centering wrapper',
    summary:
      'A div that only centers a single child (display:flex; align-items:center; ' +
      'justify-content:center) is removed; the child gains place-self:center.',
    before: '<div style="display:flex;align-items:center;justify-content:center"><Child/></div>',
    after: '<Child style="place-self:center"/>',
    safetyRationale:
      'Wrapper paints nothing, carries no ref/handlers/dynamic children, and is not a combinator ' +
      'subject; inheritable styles are folded onto the child before removal.',
  },
  evaluate(ctx: MatchContext, rw: RewriteFactory): MatchResult | null {
    const wrapper = ctx.node;
    if (!isFlexCenterWrapper(wrapper as unknown as NodeLike, ctx)) return null;

    const child = ctx.onlyElementChild();
    if (!child) return null;

    const ops: readonly RewriteOpDraft[] = [
      // 1. Preserve inheritable values (color/font/…) by folding them onto the child first.
      rw.foldInheritedStyles(wrapper, child, { conditions: 'all' }),
      // 2. Carry the centering intent down onto the child.
      rw.mergeStyle(child, null, PLACE_SELF_CENTER, 'source-wins'),
      // 3. Replace the wrapper with the child (structural-safe; preserves the child's IRNodeId).
      rw.unwrap(wrapper),
    ];

    return { ops };
  },
});
