/**
 * @domflax/patterns — flatten pattern: `nested-flex-merge`.
 *
 * Collapses a redundant nesting of two flex containers
 *
 *   <div style="display:flex; align-items:center; gap:8px">
 *     <div style="display:flex; flex-direction:column"> … </div>
 *   </div>
 *
 * where the OUTER flex container's sole element child is ITSELF a flex container, into a single
 * flex container that carries the union of both elements' flex declarations. The outer wrapper's
 * box is then structural noise (it paints nothing and only establishes a flex context that the
 * merged child now also establishes), so it is removed.
 *
 * Authored with the declarative {@link pattern} API: the match is a flex `<div>` with a single
 * element child painting nothing of its own (auto-guarded against opacity barriers / combinator
 * targeting like every `flatten/*` pattern). The value-relational reasoning — the child must also
 * be a (non-combinator) flex container, the wrapper must carry only transferable flex/inheritable
 * declarations, and the two must not conflict on any shared flex property — lives in the `rewrite`
 * op-draft factory escape hatch, which folds inherited styles, transfers the wrapper's flex
 * declarations onto the child (target-wins), then unwraps the wrapper.
 */

import type {
  ConditionKey,
  CssProperty,
  MatchContext,
  NodeLike,
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
  isElement,
  normalizer,
  not,
  pattern,
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

/** Both containers must declare `display:flex` (the matched signature). */
const DISPLAY_FLEX: StyleMap = baseConditionStyleMap([['display', 'flex']]);

/**
 * The flex-CONTAINER property set this pattern is allowed to transfer from the wrapper onto the
 * child. (Longhands only, since the shared normalizer expands `gap` → `row-gap`/`column-gap`.)
 */
const FLEX_CONTAINER_PROPERTIES: ReadonlySet<string> = new Set<string>([
  'display',
  'flex-direction',
  'flex-wrap',
  'justify-content',
  'align-items',
  'align-content',
  'place-content',
  'place-items',
  'row-gap',
  'column-gap',
]);

/* ───────────────────────── style reasoning helpers (pure) ───────────────────────── */

/**
 * True iff every declaration on the wrapper is either a transferable flex-container property or an
 * inheritable property (which we fold onto the child). If the wrapper carries anything else
 * (padding/margin/sizing/position/…), removing its box would change layout, so the merge is unsafe.
 */
function outerMergeSafe(sm: StyleMap): boolean {
  const norm = normalizer.normalizeStyleMap(sm);
  for (const block of norm.blocks.values()) {
    for (const decl of block.decls.values()) {
      if (FLEX_CONTAINER_PROPERTIES.has(String(decl.property))) continue;
      if (decl.inherited) continue;
      return false;
    }
  }
  return true;
}

/**
 * True iff the two containers disagree on any shared flex-container property (in any matching
 * condition) — e.g. `flex-direction:row` vs `flex-direction:column`. Such a conflict makes the
 * merge ambiguous, so the pattern skips.
 */
function flexConflict(outer: StyleMap, inner: StyleMap): boolean {
  const a = normalizer.normalizeStyleMap(outer);
  const b = normalizer.normalizeStyleMap(inner);
  for (const [key, blockA] of a.blocks) {
    const blockB = b.blocks.get(key);
    if (!blockB) continue;
    for (const [prop, declA] of blockA.decls) {
      if (!FLEX_CONTAINER_PROPERTIES.has(String(prop))) continue;
      const declB = blockB.decls.get(prop);
      if (declB && declB.value !== declA.value) return true;
    }
  }
  return false;
}

/** Project the wrapper's transferable flex-container declarations into a fresh StyleMap. */
function extractFlexStyle(sm: StyleMap): StyleMap {
  const blocks = new Map<ConditionKey, StyleBlock>();
  for (const [key, block] of sm.blocks) {
    const decls = new Map<CssProperty, StyleDecl>();
    for (const [prop, decl] of block.decls) {
      if (FLEX_CONTAINER_PROPERTIES.has(String(prop))) decls.set(prop, decl);
    }
    if (decls.size > 0) blocks.set(key, { condition: block.condition, decls });
  }
  return { blocks };
}

/** The inner (surviving) flex container: also a flex `<div>`, and not a combinator subject (it is reparented). */
const isInnerFlex: Matcher = and(
  isElement('div'),
  computed(DISPLAY_FLEX),
  not(targetedByCombinator),
);

/* ───────────────────────── the pattern ───────────────────────── */

/**
 * Flatten a flex container whose sole child is a compatible flex container into a single container.
 */
export const nestedFlexMerge = pattern({
  name: 'nested-flex-merge',
  category: 'flatten/nested-flex-merge',
  safety: 2,
  doc: {
    title: 'Merge nested flex containers',
    summary:
      'A flex container whose only child is itself a flex container with non-conflicting flex ' +
      'properties is collapsed into one; the wrapper is removed and its flex declarations merge ' +
      'onto the surviving child.',
    before:
      '<div style="display:flex;align-items:center;gap:8px">' +
      '<div style="display:flex;flex-direction:column"/></div>',
    after: '<div style="display:flex;flex-direction:column;align-items:center;gap:8px"/>',
    safetyRationale:
      'The wrapper paints nothing, declares only flex-container/inheritable properties, carries no ' +
      'ref/handlers/dynamic children, and is not a combinator subject; the two containers do not ' +
      'conflict on any flex property, so the union is unambiguous and lossless.',
  },
  match: {
    tag: 'div',
    style: { display: 'flex' },
    onlyChild: 'element',
    paintsNothing: true,
  },
  rewrite: (ctx: MatchContext, rw: RewriteFactory): readonly RewriteOpDraft[] | null => {
    const outer = ctx.node;
    const inner = ctx.onlyElementChild();
    if (!inner) return null;
    if (!isInnerFlex(inner as unknown as NodeLike, ctx)) return null;

    const outerStyle = ctx.computed();
    const innerStyle = ctx.computedOf(inner as unknown as NodeLike);

    // The wrapper must carry nothing that would be lost when its box is removed …
    if (!outerMergeSafe(outerStyle)) return null;
    // … and the two containers must agree on every shared flex property.
    if (flexConflict(outerStyle, innerStyle)) return null;

    return [
      // 1. Preserve inheritable values (color/font/…) by folding them onto the child first.
      rw.foldInheritedStyles(outer, inner, { conditions: 'all' }),
      // 2. Transfer the wrapper's flex-container declarations onto the child (target-wins keeps the
      //    child's value for any shared property — identical anyway, we proved non-conflict).
      rw.mergeStyle(inner, null, extractFlexStyle(outerStyle), 'target-wins'),
      // 3. Remove the wrapper (structural-safe; hoists the child and preserves its IRNodeId).
      rw.unwrap(outer),
    ];
  },
  examples: [
    {
      // The wrapper's flex declarations (align-items / gap) merge onto the inner flex container,
      // then the wrapper is removed (its own `data-x` here just blocks the more aggressive
      // passthrough-wrapper so this merge is the one that fires).
      before:
        '<div className="flex items-center gap-2" data-x="1">' +
        '<div className="flex flex-col">X</div>' +
        '</div>',
      after: '<div className="flex flex-col gap-2 items-center">X</div>',
    },
    {
      // A non-flex wrapper does not match the flex-container signature → left unchanged.
      noMatch:
        '<div className="block bg-blue-500">' +
        '<div className="flex flex-col">X</div>' +
        '</div>',
    },
  ],
});
