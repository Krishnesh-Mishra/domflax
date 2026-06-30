/**
 * @domflax/patterns — compress pattern: `overscroll-behavior-shorthand`.
 *
 * Collapses an element whose two overscroll-behavior axes are expressed as separate longhand
 * declarations and are EQUAL into the single CSS `overscroll-behavior` shorthand:
 *
 *   overscroll-behavior-x:contain; overscroll-behavior-y:contain
 *     ⇒  overscroll-behavior:contain           (Tailwind `overscroll-x-contain overscroll-y-contain` → `overscroll-contain`)
 *
 * Tailwind's `overscroll-x-*` / `overscroll-y-*` utilities each resolve to the matching
 * `overscroll-behavior-{x,y}` axis longhand, and the shared normalizer keeps `overscroll-behavior`
 * un-expanded (it is NOT one of the box/gap shorthands the normalizer splits). So only the equal-axis
 * form maps cleanly to a single `overscroll-*` utility. This pass runs the collapse in reverse on the
 * computed map ONLY when both axes carry the SAME value and `!important` flag, replacing them with one
 * `overscroll-behavior` decl so the minimizing reverse-emit can pick a single `overscroll-*` token
 * instead of two axis tokens. When the axes differ it declines, leaving the two longhands verbatim.
 *
 * Authored with the declarative {@link pattern} API: `definePattern` auto-applies the compress safety guards — a dynamic or opaque class list
 * and combinator-subject selectors are excluded (a ref / event handler / dynamic child / dangerous
 * HTML never blocks a class-only rewrite); the
 * `rewriteClasses` recipe rebuilds the class StyleMap, declining (`null`) unless both axes are
 * present, concrete, equal, and share an `!important` flag.
 */

import type { ConditionKey, CssProperty, CssValue, StyleBlock, StyleDecl, StyleMap } from '@domflax/core';
import { BASE_CONDITION, conditionKey } from '@domflax/core';

import { definePattern } from '@domflax/pattern-kit';

/* ───────────────────────── property handles ───────────────────────── */

const OVERSCROLL_X = 'overscroll-behavior-x' as CssProperty;
const OVERSCROLL_Y = 'overscroll-behavior-y' as CssProperty;
const OVERSCROLL = 'overscroll-behavior' as CssProperty;

const BASE_KEY: ConditionKey = conditionKey(BASE_CONDITION);

/** CSS-wide keywords for which an axis collapse is pointless or unsound. */
const NON_COLLAPSIBLE_VALUES: ReadonlySet<string> = new Set<string>([
  'initial',
  'inherit',
  'unset',
  'revert',
  'revert-layer',
]);

/* ───────────────────────── helpers ───────────────────────── */

/**
 * Rebuild the computed StyleMap with the BASE block's overscroll-behavior x/y pair replaced by a
 * single `overscroll-behavior` declaration; all other conditions/blocks are preserved verbatim. The
 * synthesized shorthand decl is set LITERALLY (the normalizer leaves `overscroll-behavior` intact),
 * so the emit side matches the single `overscroll-*` utility.
 */
function withOverscrollShorthand(sm: StyleMap, shorthand: StyleDecl): StyleMap {
  const blocks = new Map<ConditionKey, StyleBlock>();
  for (const [key, block] of sm.blocks) {
    if (key !== BASE_KEY) {
      blocks.set(key, block);
      continue;
    }
    const decls = new Map<CssProperty, StyleDecl>();
    for (const [prop, decl] of block.decls) {
      if (prop === OVERSCROLL_X || prop === OVERSCROLL_Y) continue; // drop the two axis longhands
      decls.set(prop, decl);
    }
    decls.set(shorthand.property, shorthand);
    blocks.set(key, { condition: block.condition, decls });
  }
  return { blocks };
}

/* ───────────────────────── the pattern ───────────────────────── */

/** Fold an equal overscroll-behavior x/y pair into the single `overscroll-behavior` shorthand. */
export const overscrollBehaviorShorthand = definePattern({
  name: 'overscroll-behavior-shorthand',
  category: 'compress/overscroll-behavior-shorthand',
  safety: 1,
  doc: {
    title: 'Collapse equal overscroll-behavior axes into overscroll-behavior',
    summary:
      'An element whose computed overscroll-behavior-x and overscroll-behavior-y are equal has the ' +
      'two axis longhands collapsed into a single `overscroll-behavior` shorthand (Tailwind ' +
      'overscroll-x-* overscroll-y-* → overscroll-*).',
    before: '<div style="overscroll-behavior-x:contain;overscroll-behavior-y:contain"/>',
    after: '<div class="overscroll-contain"/>',
    safetyRationale:
      '`overscroll-behavior` is value-identical to an equal x+y axis pair — a class-only change. It is ' +
      'safe even on an element with a ref, event handler, dynamic child, or dangerouslySetInnerHTML — a ' +
      'className rewrite touches none of them; only a dynamic/opaque class list or a combinator-subject ' +
      'class is excluded, so no behaviour or project selector is disturbed.',
  },
  rewrite: {
    rewriteClasses(computed: StyleMap): StyleMap | null {
      const base = computed.blocks.get(BASE_KEY);
      if (!base) return null;

      const x = base.decls.get(OVERSCROLL_X);
      const y = base.decls.get(OVERSCROLL_Y);
      if (!x || !y) return null;

      // A single shorthand cannot carry per-axis `!important` or differing values.
      if (x.important !== y.important) return null;
      const value = String(x.value);
      if (NON_COLLAPSIBLE_VALUES.has(value)) return null;
      if (value !== String(y.value)) return null;

      const shorthand: StyleDecl = {
        property: OVERSCROLL,
        value: x.value as CssValue,
        important: x.important,
        relativeToParent: x.relativeToParent || y.relativeToParent,
        inherited: false, // overscroll-behavior is not an inherited property
      };
      return withOverscrollShorthand(computed, shorthand);
    },
  },
  test: {
    cases: [
      {
        // Equal x/y axes collapse to an `overscroll-behavior` decl at the IR level; the minimizing
        // reverse-emit picks the single utility covering both (`overscroll-contain`), replacing the
        // `overscroll-x-contain`+`overscroll-y-contain` pair. `bg-red-200` is preserved.
        before: '<div className="overscroll-x-contain overscroll-y-contain bg-red-200">box</div>',
        after: '<div className="bg-red-200 overscroll-contain">box</div>',
      },
    ],
    // Axes differ (x != y) → no equal-axis collapse.
    noMatch: ['<div className="overscroll-x-contain overscroll-y-auto bg-red-200">box</div>'],
  },
});
