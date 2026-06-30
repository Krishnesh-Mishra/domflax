/**
 * @domflax/patterns — compress pattern: `border-radius-shorthand`.
 *
 * Collapses an element whose four corner radii are expressed as separate longhand declarations and
 * are ALL EQUAL into the single CSS `border-radius` shorthand:
 *
 *   border-top-left-radius:0.5rem; border-top-right-radius:0.5rem;
 *   border-bottom-right-radius:0.5rem; border-bottom-left-radius:0.5rem
 *     ⇒  border-radius:0.5rem                  (Tailwind `rounded-lg`)
 *
 * The IR's computed StyleMap keeps each corner as its own longhand (Tailwind's `rounded-tl-*` /
 * `rounded-tr-*` / … each resolve to one corner property). This pass runs the collapse in reverse on
 * the computed map ONLY when all four corners share one value — the single case that maps cleanly to
 * a single Tailwind utility (the CSS 2-value `border-radius` form is DIAGONAL, which has no clean
 * `rounded-*` edge utility, so per-corner differences are intentionally left alone). Rebuilding the
 * map with one `border-radius` decl lets the minimizing reverse-emit pick the single `rounded-*`
 * token covering all four corners instead of two edge tokens.
 *
 * Authored with the declarative {@link pattern} API: the `where` guards exclude opacity barriers,
 * dynamic class lists, and combinator subjects (compress patterns get NO auto-guards); the
 * `rewriteClasses` recipe rebuilds the class StyleMap, declining (`null`) unless the four corners are
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
  definePattern,
  targetedByCombinator,
  type Matcher,
} from '@domflax/pattern-kit';

/* ───────────────────────── corner analysis ───────────────────────── */

/** The four corner-radius longhands. */
const CORNERS = [
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
] as const satisfies readonly string[];

const CORNER_SET: ReadonlySet<string> = new Set<string>(CORNERS);

const BASE_KEY: ConditionKey = conditionKey(BASE_CONDITION);

const RADIUS = 'border-radius' as CssProperty;

/** CSS-wide keywords for which a corner collapse is pointless or unsound. */
const NON_COLLAPSIBLE_VALUES: ReadonlySet<string> = new Set<string>([
  'initial',
  'inherit',
  'unset',
  'revert',
  'revert-layer',
]);

/** The single value all four corners fold into (carrying important / relative-unit flags). */
interface RadiusFold {
  readonly value: string;
  readonly important: boolean;
  readonly relative: boolean;
}

/**
 * Inspect the BASE-condition block of `sm` and, iff all four corner longhands are present, share a
 * uniform `!important` flag, hold a concrete (non-keyword) value, and are ALL EQUAL, return that
 * value. Returns `null` when the corners cannot fold to one `border-radius`.
 */
function analyzeRadius(sm: StyleMap): RadiusFold | null {
  const block = sm.blocks.get(BASE_KEY);
  if (!block) return null;

  const corners: StyleDecl[] = [];
  for (const corner of CORNERS) {
    const decl = block.decls.get(corner as CssProperty);
    if (!decl) return null;
    corners.push(decl);
  }

  // A shorthand cannot carry per-corner `!important`; only fold a uniform flag.
  const important = corners[0]!.important;
  if (!corners.every((d) => d.important === important)) return null;

  const value = String(corners[0]!.value);
  if (NON_COLLAPSIBLE_VALUES.has(value)) return null;
  if (!corners.every((d) => String(d.value) === value)) return null;

  const relative = corners.some((d) => d.relativeToParent);
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

/** Rebuild `sm` with the four BASE-block corner longhands replaced by one `border-radius` decl. */
function withFoldedRadius(sm: StyleMap, fold: RadiusFold): StyleMap {
  const blocks = new Map<ConditionKey, StyleBlock>();
  for (const [key, block] of sm.blocks) {
    if (key !== BASE_KEY) {
      blocks.set(key, block);
      continue;
    }
    const decls = new Map<CssProperty, StyleDecl>();
    for (const [prop, decl] of block.decls) {
      if (CORNER_SET.has(String(prop))) continue; // drop the four corner longhands
      decls.set(prop, decl);
    }
    const shorthand: StyleDecl = {
      property: RADIUS,
      value: fold.value as CssValue,
      important: fold.important,
      relativeToParent: fold.relative,
      inherited: false, // border-radius is never inherited
    };
    decls.set(shorthand.property, shorthand);
    blocks.set(key, { condition: block.condition, decls });
  }
  return { blocks };
}

/* ───────────────────────── the pattern ───────────────────────── */

/** Fold four equal corner radii into the single `border-radius` shorthand. */
export const borderRadiusShorthand = definePattern({
  name: 'border-radius-shorthand',
  category: 'compress/border-radius-shorthand',
  safety: 1,
  doc: {
    title: 'Collapse equal corner radii into border-radius',
    summary:
      'An element whose four corner radii (border-*-radius longhands) are all equal is rewritten to ' +
      'the single Tailwind rounded-* utility (border-radius === the four equal corners).',
    before: '<div class="rounded-tl-lg rounded-tr-lg rounded-br-lg rounded-bl-lg"/>',
    after: '<div class="rounded-lg"/>',
    safetyRationale:
      'border-radius is value-identical to four equal corner radii; the element carries no ref/' +
      'handlers/dynamic children/dangerous HTML, no dynamic class segment, and is not a combinator ' +
      'subject, so no JS identity, behaviour, or project selector is disturbed.',
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
      const fold = analyzeRadius(computed);
      return fold ? withFoldedRadius(computed, fold) : null;
    },
  },
  test: {
    cases: [
      {
        // The four equal corner longhands collapse to a `border-radius` decl at the IR level; the
        // minimizing reverse-emit then picks the single shortest utility (`rounded-lg`) that reproduces
        // it, replacing the four `rounded-{tl,tr,br,bl}-lg` tokens. `bg-red-200` is preserved.
        before: '<div className="rounded-tl-lg rounded-tr-lg rounded-br-lg rounded-bl-lg bg-red-200">box</div>',
        after: '<div className="bg-red-200 rounded-lg">box</div>',
      },
    ],
    // Corners differ (top corners vs bottom corners) → no all-equal collapse.
    noMatch: ['<div className="rounded-t-lg rounded-b-sm bg-red-200">box</div>'],
  },
});
