/**
 * @domflax/patterns — compress pattern: `scroll-margin-shorthand`.
 *
 * Collapses an element whose four scroll-margin sides are expressed as separate longhand
 * declarations and are ALL EQUAL into the single CSS `scroll-margin` shorthand:
 *
 *   scroll-margin-top:1rem; scroll-margin-right:1rem;
 *   scroll-margin-bottom:1rem; scroll-margin-left:1rem
 *     ⇒  scroll-margin:1rem                    (Tailwind `scroll-m-4`)
 *
 * Tailwind's `scroll-mt-*` / `scroll-mx-*` / … utilities each resolve to the matching
 * `scroll-margin-*` longhand(s), and the shared normalizer keeps `scroll-margin` un-expanded (it is
 * NOT one of the box shorthands the normalizer splits). So only the all-equal (1-value) form maps
 * cleanly to a single `scroll-m-*` utility — the 2-value (`scroll-mx`/`scroll-my`) shape is left to
 * the resolver's own reverse-emit. This pass runs the collapse in reverse on the computed map ONLY
 * when all four sides share one value, replacing them with one `scroll-margin` decl so the minimizing
 * reverse-emit can pick a single `scroll-m-*` token instead of two axis tokens.
 *
 * Authored with the declarative {@link pattern} API: the `where` guards exclude opacity barriers,
 * dynamic class lists, and combinator subjects (compress patterns get NO auto-guards); the
 * `rewriteClasses` recipe rebuilds the class StyleMap, declining (`null`) unless the four sides are
 * present, concrete, equal, and share an `!important` flag.
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

/* ───────────────────────── scroll-margin analysis ───────────────────────── */

/** The four scroll-margin longhands. */
const SCROLL_MARGIN_SIDES = [
  'scroll-margin-top',
  'scroll-margin-right',
  'scroll-margin-bottom',
  'scroll-margin-left',
] as const satisfies readonly string[];

const SIDE_SET: ReadonlySet<string> = new Set<string>(SCROLL_MARGIN_SIDES);

const BASE_KEY: ConditionKey = conditionKey(BASE_CONDITION);

const SCROLL_MARGIN = 'scroll-margin' as CssProperty;

/** CSS-wide keywords for which a side collapse is pointless or unsound. */
const NON_COLLAPSIBLE_VALUES: ReadonlySet<string> = new Set<string>([
  'initial',
  'inherit',
  'unset',
  'revert',
  'revert-layer',
]);

/** The single value all four sides fold into (carrying important / relative-unit flags). */
interface ScrollMarginFold {
  readonly value: string;
  readonly important: boolean;
  readonly relative: boolean;
}

/**
 * Inspect the BASE-condition block of `sm` and, iff all four scroll-margin longhands are present,
 * share a uniform `!important` flag, hold a concrete (non-keyword) value, and are ALL EQUAL, return
 * that value. Returns `null` when the sides cannot fold to one `scroll-margin`.
 */
function analyzeScrollMargin(sm: StyleMap): ScrollMarginFold | null {
  const block = sm.blocks.get(BASE_KEY);
  if (!block) return null;

  const sides: StyleDecl[] = [];
  for (const side of SCROLL_MARGIN_SIDES) {
    const decl = block.decls.get(side as CssProperty);
    if (!decl) return null;
    sides.push(decl);
  }

  // A shorthand cannot carry per-side `!important`; only fold a uniform flag.
  const important = sides[0]!.important;
  if (!sides.every((d) => d.important === important)) return null;

  const value = String(sides[0]!.value);
  if (NON_COLLAPSIBLE_VALUES.has(value)) return null;
  if (!sides.every((d) => String(d.value) === value)) return null;

  const relative = sides.some((d) => d.relativeToParent);
  return { value, important, relative };
}

/* ───────────────────────── match guards ───────────────────────── */

function asElement(node: NodeLike): DeepReadonly<IRElement> | null {
  const n = node as DeepReadonly<IRNode>;
  return n.kind === 'element' ? (n as DeepReadonly<IRElement>) : null;
}

/** Element carries raw/dangerous HTML (e.g. dangerouslySetInnerHTML) — a hard opacity barrier. */
const hasDangerousHtml: Matcher = (node) => asElement(node)?.meta.hasDangerousHtml ?? false;

/* ───────────────────────── style rebuild ───────────────────────── */

/** Rebuild `sm` with the four BASE-block scroll-margin longhands replaced by one shorthand decl. */
function withFoldedScrollMargin(sm: StyleMap, fold: ScrollMarginFold): StyleMap {
  const blocks = new Map<ConditionKey, StyleBlock>();
  for (const [key, block] of sm.blocks) {
    if (key !== BASE_KEY) {
      blocks.set(key, block);
      continue;
    }
    const decls = new Map<CssProperty, StyleDecl>();
    for (const [prop, decl] of block.decls) {
      if (SIDE_SET.has(String(prop))) continue; // drop the four longhands
      decls.set(prop, decl);
    }
    const shorthand: StyleDecl = {
      property: SCROLL_MARGIN,
      value: fold.value as CssValue,
      important: fold.important,
      relativeToParent: fold.relative,
      inherited: false, // scroll-margin is never inherited
    };
    decls.set(shorthand.property, shorthand);
    blocks.set(key, { condition: block.condition, decls });
  }
  return { blocks };
}

/* ───────────────────────── the pattern ───────────────────────── */

/** Fold four equal scroll-margin sides into the single `scroll-margin` shorthand. */
export const scrollMarginShorthand = pattern({
  name: 'scroll-margin-shorthand',
  category: 'compress/scroll-margin-shorthand',
  safety: 1,
  doc: {
    title: 'Collapse equal scroll-margin sides into scroll-margin',
    summary:
      'An element whose four scroll-margin sides are all equal is rewritten to the single Tailwind ' +
      'scroll-m-* utility (scroll-margin === the four equal sides).',
    before: '<div class="scroll-mt-4 scroll-mr-4 scroll-mb-4 scroll-ml-4"/>',
    after: '<div class="scroll-m-4"/>',
    safetyRationale:
      'scroll-margin is value-identical to four equal scroll-margin sides; the element carries no ' +
      'ref/handlers/dynamic children/dangerous HTML, no dynamic class segment, and is not a ' +
      'combinator subject, so no JS identity, behaviour, or project selector is disturbed.',
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
      const fold = analyzeScrollMargin(computed);
      return fold ? withFoldedScrollMargin(computed, fold) : null;
    },
  },
  examples: [
    {
      // The four equal scroll-margin longhands collapse to a `scroll-margin` decl at the IR level; the
      // minimizing reverse-emit then picks the single shortest utility (`scroll-m-4`) that reproduces
      // it, replacing the four `scroll-m{t,r,b,l}-4` tokens. `bg-red-200` is preserved.
      before: '<div className="scroll-mt-4 scroll-mr-4 scroll-mb-4 scroll-ml-4 bg-red-200">box</div>',
      after: '<div className="bg-red-200 scroll-m-4">box</div>',
    },
    {
      // Sides differ (top != bottom) → no all-equal collapse.
      noMatch: '<div className="scroll-mt-2 scroll-mr-4 scroll-mb-8 scroll-ml-4 bg-red-200">box</div>',
    },
  ],
});
