/**
 * @domflax/patterns — compress pattern: `place-shorthand`.
 *
 * Recompacts the grid/flex alignment longhands on an element's computed style into the CSS `place-*`
 * shorthands whenever the two axes of a pair agree:
 *
 *   • align-items   == justify-items     → `place-items: <v>`     (Tailwind `items-* justify-items-*`)
 *   • align-content == justify-content   → `place-content: <v>`   (Tailwind `content-* justify-*`)
 *
 * The two collapses are INDEPENDENT: an element whose items pair agrees but whose content pair does
 * not collapses only `place-items` and keeps the content longhands verbatim. The shared normalizer
 * leaves all four alignment properties as independent longhands (it synthesizes no `place-*`
 * shorthand), so an element styled with two matching axis utilities keeps the longhands until this
 * pass folds them. When neither pair agrees the pattern declines.
 *
 * Authored with the declarative {@link pattern} API: the `where` guards exclude opacity barriers,
 * dynamic class lists, and combinator subjects (compress patterns get NO auto-guards); the
 * `rewriteClasses` recipe rebuilds the class StyleMap, declining (`null`) unless at least one
 * alignment pair collapses.
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

/* ───────────────────────── property handles ───────────────────────── */

const ALIGN_ITEMS = 'align-items' as CssProperty;
const JUSTIFY_ITEMS = 'justify-items' as CssProperty;
const PLACE_ITEMS = 'place-items' as CssProperty;

const ALIGN_CONTENT = 'align-content' as CssProperty;
const JUSTIFY_CONTENT = 'justify-content' as CssProperty;
const PLACE_CONTENT = 'place-content' as CssProperty;

const BASE_KEY: ConditionKey = conditionKey(BASE_CONDITION);

/* ───────────────────────── helpers ───────────────────────── */

function asElement(node: NodeLike): DeepReadonly<IRElement> | null {
  const n = node as DeepReadonly<IRNode>;
  return n.kind === 'element' ? (n as DeepReadonly<IRElement>) : null;
}

/** Element carries raw/dangerous HTML (e.g. dangerouslySetInnerHTML) — a hard opacity barrier. */
const hasDangerousHtml: Matcher = (node) => asElement(node)?.meta.hasDangerousHtml ?? false;

/** Two alignment decls collapse only if they agree on BOTH normalized value and `!important`. */
function samePair(a: StyleDecl | undefined, b: StyleDecl | undefined): boolean {
  return a !== undefined && b !== undefined && a.value === b.value && a.important === b.important;
}

/** Build a `place-*` shorthand decl carrying the (uniform) value/`!important` of its axis pair. */
function placeDecl(property: CssProperty, align: StyleDecl): StyleDecl {
  return {
    property,
    value: align.value as CssValue,
    important: align.important,
    relativeToParent: false, // alignment keywords (center/start/stretch/…) are not length-relative
    inherited: false, // none of the place-* alignment properties are inherited
  };
}

/** Rebuild `sm` with the base block's decls replaced; all other condition blocks pass through. */
function withBaseDecls(sm: StyleMap, baseDecls: ReadonlyMap<CssProperty, StyleDecl>): StyleMap {
  const blocks = new Map<ConditionKey, StyleBlock>();
  for (const [key, block] of sm.blocks) {
    const decls =
      key === BASE_KEY ? new Map<CssProperty, StyleDecl>(baseDecls) : block.decls;
    blocks.set(key, { condition: block.condition, decls });
  }
  return { blocks };
}

/* ───────────────────────── the pattern ───────────────────────── */

/** Fold matching align/justify pairs into the `place-items` / `place-content` shorthands. */
export const placeShorthand = definePattern({
  name: 'place-shorthand',
  category: 'compress/place-shorthand',
  safety: 1,
  doc: {
    title: 'Collapse matching alignment pairs into `place-*` shorthands',
    summary:
      'When align-items equals justify-items they collapse to `place-items`; when align-content ' +
      'equals justify-content they collapse to `place-content`. The two collapses are independent.',
    before: '<div style="align-items:center;justify-items:center"/>',
    after: '<div style="place-items:center"/>',
    safetyRationale:
      'A `place-*` shorthand is value-identical to its equal align/justify pair; the element ' +
      'carries no ref/handlers/dynamic children/dangerous HTML, no dynamic class segment, and is ' +
      'not a combinator subject, so neither behaviour nor any project selector is disturbed.',
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
      const base = computed.blocks.get(BASE_KEY);
      if (!base) return null;

      const alignItems = base.decls.get(ALIGN_ITEMS);
      const justifyItems = base.decls.get(JUSTIFY_ITEMS);
      const alignContent = base.decls.get(ALIGN_CONTENT);
      const justifyContent = base.decls.get(JUSTIFY_CONTENT);

      const next = new Map<CssProperty, StyleDecl>(base.decls);
      let collapsed = false;

      // 1. Items axis: align-items == justify-items → `place-items`.
      if (samePair(alignItems, justifyItems)) {
        next.delete(ALIGN_ITEMS);
        next.delete(JUSTIFY_ITEMS);
        next.set(PLACE_ITEMS, placeDecl(PLACE_ITEMS, alignItems!));
        collapsed = true;
      }
      // 2. Content axis: align-content == justify-content → `place-content`.
      if (samePair(alignContent, justifyContent)) {
        next.delete(ALIGN_CONTENT);
        next.delete(JUSTIFY_CONTENT);
        next.set(PLACE_CONTENT, placeDecl(PLACE_CONTENT, alignContent!));
        collapsed = true;
      }

      if (!collapsed) return null; // nothing to compress — decline
      return withBaseDecls(computed, next);
    },
  },
  test: {
    cases: [
      {
        // The matching items pair collapses to a `place-items` decl at the IR level; the minimizing
        // reverse-emit picks the single utility covering both (`place-items-center`), replacing the
        // `items-center`+`justify-items-center` pair. `bg-red-200` is preserved.
        before: '<div className="items-center justify-items-center bg-red-200">box</div>',
        after: '<div className="bg-red-200 place-items-center">box</div>',
      },
    ],
    // Mismatched alignment (align-items != justify-items, no content pair) → nothing collapses.
    noMatch: ['<div className="items-center justify-items-start bg-red-200">box</div>'],
  },
});
