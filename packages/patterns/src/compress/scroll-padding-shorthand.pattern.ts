/**
 * @domflax/patterns — compress pattern: `scroll-padding-shorthand`.
 *
 * Collapses an element whose four scroll-padding sides are expressed as separate longhand
 * declarations and are ALL EQUAL into the single CSS `scroll-padding` shorthand:
 *
 *   scroll-padding-top:1rem; scroll-padding-right:1rem;
 *   scroll-padding-bottom:1rem; scroll-padding-left:1rem
 *     ⇒  scroll-padding:1rem                   (Tailwind `scroll-p-4`)
 *
 * Tailwind's `scroll-pt-*` / `scroll-px-*` / … utilities each resolve to the matching
 * `scroll-padding-*` longhand(s), and the shared normalizer keeps `scroll-padding` un-expanded (it is
 * NOT one of the box shorthands the normalizer splits). So only the all-equal (1-value) form maps
 * cleanly to a single `scroll-p-*` utility — the 2-value (`scroll-px`/`scroll-py`) shape is left to
 * the resolver's own reverse-emit. This pass runs the collapse in reverse on the computed map ONLY
 * when all four sides share one value, replacing them with one `scroll-padding` decl so the minimizing
 * reverse-emit can pick a single `scroll-p-*` token instead of two axis tokens.
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

/* ───────────────────────── scroll-padding analysis ───────────────────────── */

/** The four scroll-padding longhands. */
const SCROLL_PADDING_SIDES = [
  'scroll-padding-top',
  'scroll-padding-right',
  'scroll-padding-bottom',
  'scroll-padding-left',
] as const satisfies readonly string[];

const SIDE_SET: ReadonlySet<string> = new Set<string>(SCROLL_PADDING_SIDES);

const BASE_KEY: ConditionKey = conditionKey(BASE_CONDITION);

const SCROLL_PADDING = 'scroll-padding' as CssProperty;

/** CSS-wide keywords for which a side collapse is pointless or unsound. */
const NON_COLLAPSIBLE_VALUES: ReadonlySet<string> = new Set<string>([
  'initial',
  'inherit',
  'unset',
  'revert',
  'revert-layer',
]);

/** The single value all four sides fold into (carrying important / relative-unit flags). */
interface ScrollPaddingFold {
  readonly value: string;
  readonly important: boolean;
  readonly relative: boolean;
}

/**
 * Inspect the BASE-condition block of `sm` and, iff all four scroll-padding longhands are present,
 * share a uniform `!important` flag, hold a concrete (non-keyword) value, and are ALL EQUAL, return
 * that value. Returns `null` when the sides cannot fold to one `scroll-padding`.
 */
function analyzeScrollPadding(sm: StyleMap): ScrollPaddingFold | null {
  const block = sm.blocks.get(BASE_KEY);
  if (!block) return null;

  const sides: StyleDecl[] = [];
  for (const side of SCROLL_PADDING_SIDES) {
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

/** Rebuild `sm` with the four BASE-block scroll-padding longhands replaced by one shorthand decl. */
function withFoldedScrollPadding(sm: StyleMap, fold: ScrollPaddingFold): StyleMap {
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
      property: SCROLL_PADDING,
      value: fold.value as CssValue,
      important: fold.important,
      relativeToParent: fold.relative,
      inherited: false, // scroll-padding is never inherited
    };
    decls.set(shorthand.property, shorthand);
    blocks.set(key, { condition: block.condition, decls });
  }
  return { blocks };
}

/* ───────────────────────── the pattern ───────────────────────── */

/** Fold four equal scroll-padding sides into the single `scroll-padding` shorthand. */
export const scrollPaddingShorthand = pattern({
  name: 'scroll-padding-shorthand',
  category: 'compress/scroll-padding-shorthand',
  safety: 1,
  doc: {
    title: 'Collapse equal scroll-padding sides into scroll-padding',
    summary:
      'An element whose four scroll-padding sides are all equal is rewritten to the single Tailwind ' +
      'scroll-p-* utility (scroll-padding === the four equal sides).',
    before: '<div class="scroll-pt-4 scroll-pr-4 scroll-pb-4 scroll-pl-4"/>',
    after: '<div class="scroll-p-4"/>',
    safetyRationale:
      'scroll-padding is value-identical to four equal scroll-padding sides; the element carries no ' +
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
      const fold = analyzeScrollPadding(computed);
      return fold ? withFoldedScrollPadding(computed, fold) : null;
    },
  },
  examples: [
    {
      // The four equal scroll-padding longhands collapse to a `scroll-padding` decl at the IR level;
      // the minimizing reverse-emit then picks the single shortest utility (`scroll-p-4`) that
      // reproduces it, replacing the four `scroll-p{t,r,b,l}-4` tokens. `bg-red-200` is preserved.
      before: '<div className="scroll-pt-4 scroll-pr-4 scroll-pb-4 scroll-pl-4 bg-red-200">box</div>',
      after: '<div className="bg-red-200 scroll-p-4">box</div>',
    },
    {
      // Sides differ (top != bottom) → no all-equal collapse.
      noMatch: '<div className="scroll-pt-2 scroll-pr-4 scroll-pb-8 scroll-pl-4 bg-red-200">box</div>',
    },
  ],
});
