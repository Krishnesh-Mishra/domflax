/**
 * @domflax/patterns — compress pattern: `gap-shorthand`.
 *
 * Collapses an element whose grid/flex gutters are expressed as two equal axis longhands back into
 * the single `gap` shorthand:
 *
 *   row-gap:16px; column-gap:16px   ⇒   gap:16px            (Tailwind `gap-x-4 gap-y-4` → `gap-4`)
 *
 * The IR's computed StyleMap is canonically LONGHAND (the shared normalizer expands the `gap`
 * shorthand into `row-gap` + `column-gap` at parse time). This pass runs the expansion in reverse on
 * the computed map ONLY when both axes carry the SAME value and `!important` flag — i.e. when the two
 * gutters genuinely fold into a single-value `gap`. When the axes differ it declines, leaving the two
 * longhands verbatim (an asymmetric gutter has no equivalent single-value shorthand).
 *
 * Authored with the declarative {@link pattern} API: `definePattern` auto-applies the compress safety guards — a dynamic or opaque class list
 * and combinator-subject selectors are excluded (a ref / event handler / dynamic child / dangerous
 * HTML never blocks a class-only rewrite); the
 * `rewriteClasses` recipe rebuilds the class StyleMap, declining (`null`) unless the two axis gaps
 * are present, equal, and share an `!important` flag.
 */

import type { ConditionKey, CssProperty, CssValue, StyleBlock, StyleDecl, StyleMap } from '@domflax/core';
import { BASE_CONDITION, conditionKey } from '@domflax/core';

import { definePattern } from '@domflax/pattern-kit';

/* ───────────────────────── property handles ───────────────────────── */

const ROW_GAP = 'row-gap' as CssProperty;
const COLUMN_GAP = 'column-gap' as CssProperty;
const GAP = 'gap' as CssProperty;

const BASE_KEY: ConditionKey = conditionKey(BASE_CONDITION);

/* ───────────────────────── helpers ───────────────────────── */

/**
 * Rebuild the computed StyleMap with the BASE block's `row-gap`/`column-gap` pair replaced by a
 * single `gap` declaration; all other conditions/blocks are preserved verbatim. The synthesized
 * `gap` decl is set LITERALLY (not via the normalizer, which would re-expand it back into the two
 * axis longhands), so the emit side re-expands and matches the single `gap-*` utility.
 */
function withGapShorthand(sm: StyleMap, gapDecl: StyleDecl): StyleMap {
  const blocks = new Map<ConditionKey, StyleBlock>();
  for (const [key, block] of sm.blocks) {
    if (key !== BASE_KEY) {
      blocks.set(key, block);
      continue;
    }
    const decls = new Map<CssProperty, StyleDecl>();
    for (const [prop, decl] of block.decls) {
      if (prop === ROW_GAP || prop === COLUMN_GAP) continue; // drop the two axis longhands
      decls.set(prop, decl);
    }
    decls.set(gapDecl.property, gapDecl);
    blocks.set(key, { condition: block.condition, decls });
  }
  return { blocks };
}

/* ───────────────────────── the pattern ───────────────────────── */

/** Fold an equal `row-gap`/`column-gap` pair into the single `gap` shorthand. */
export const gapShorthand = definePattern({
  name: 'gap-shorthand',
  category: 'compress/gap-shorthand',
  safety: 1,
  doc: {
    title: 'Collapse equal row/column gap into the `gap` shorthand',
    summary:
      'An element whose computed row-gap and column-gap are equal has the two axis longhands ' +
      'collapsed into a single-value `gap` shorthand (Tailwind gap-x-* gap-y-* → gap-*).',
    before: '<div style="row-gap:16px;column-gap:16px"/>',
    after: '<div style="gap:16px"/>',
    safetyRationale:
      'A single-value `gap` is value-identical to an equal row-gap+column-gap pair — a class-only change. ' +
      'It is safe even on an element with a ref, event handler, dynamic child, or dangerouslySetInnerHTML ' +
      '— a className rewrite touches none of them; only a dynamic/opaque class list or a ' +
      'combinator-subject class is excluded, so no behaviour or project selector is disturbed.',
  },
  rewrite: {
    rewriteClasses(computed: StyleMap): StyleMap | null {
      const base = computed.blocks.get(BASE_KEY);
      if (!base) return null;

      const rowGap = base.decls.get(ROW_GAP);
      const colGap = base.decls.get(COLUMN_GAP);
      if (!rowGap || !colGap) return null;

      // A single-value `gap` cannot carry per-axis `!important` or differing values.
      if (rowGap.important !== colGap.important) return null;
      if (rowGap.value !== colGap.value) return null;

      const gapDecl: StyleDecl = {
        property: GAP,
        value: rowGap.value as CssValue,
        important: rowGap.important,
        relativeToParent: rowGap.relativeToParent || colGap.relativeToParent,
        inherited: false, // gap is not an inherited property
      };
      return withGapShorthand(computed, gapDecl);
    },
  },
  test: {
    cases: [
      {
        // Equal row/column gap collapse to a `gap` decl at the IR level; the minimizing reverse-emit
        // re-expands `gap` to row-gap+column-gap and picks the single utility covering both (`gap-4`),
        // replacing the `gap-x-4`+`gap-y-4` pair. `bg-red-200` is preserved.
        before: '<div className="gap-x-4 gap-y-4 bg-red-200">box</div>',
        after: '<div className="bg-red-200 gap-4">box</div>',
      },
    ],
    // Unequal axes (row-gap != column-gap) have no single-value `gap` equivalent → not collapsed.
    noMatch: ['<div className="gap-x-2 gap-y-4 bg-red-200">box</div>'],
  },
});
