/**
 * @domflax/patterns — flatten pattern: `nested-grid-merge`.
 *
 * Collapses a redundant nesting of two grid containers
 *
 *   <div style="display:grid; gap:8px">
 *     <div style="display:grid; grid-template-columns:1fr 1fr"> … </div>
 *   </div>
 *
 * where the OUTER grid container's sole element child is ITSELF a grid container, into a single grid
 * container carrying the union of both elements' grid declarations. The outer wrapper's box is then
 * structural noise (it paints nothing and only establishes a grid context the merged child now also
 * establishes), so it is removed.
 *
 * This is the grid analogue of `nested-flex-merge`. The declarative match is a grid `<div>` with a
 * single element child painting nothing of its own (auto-guarded against opacity barriers / combinator
 * targeting like every `flatten/*` pattern). The value-relational reasoning — the child must also be a
 * (non-combinator) grid container, the wrapper must carry only transferable grid/inheritable
 * declarations, and the two must not conflict on any shared grid property — lives in the `rewrite`
 * op-draft factory escape hatch, which folds inherited styles, transfers the wrapper's grid
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
  definePattern,
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

/** Both containers must declare `display:grid` (the matched signature). */
const DISPLAY_GRID: StyleMap = baseConditionStyleMap([['display', 'grid']]);

/**
 * The grid-CONTAINER property set this pattern is allowed to transfer from the wrapper onto the child.
 * (Longhands only, since the shared normalizer expands `gap` → `row-gap`/`column-gap`.)
 */
const GRID_CONTAINER_PROPERTIES: ReadonlySet<string> = new Set<string>([
  'display',
  'grid-template-columns',
  'grid-template-rows',
  'grid-template-areas',
  'grid-auto-columns',
  'grid-auto-rows',
  'grid-auto-flow',
  'justify-content',
  'align-content',
  'place-content',
  'justify-items',
  'align-items',
  'place-items',
  'row-gap',
  'column-gap',
]);

/* ───────────────────────── style reasoning helpers (pure) ───────────────────────── */

/**
 * True iff every declaration on the wrapper is either a transferable grid-container property or an
 * inheritable property (which we fold onto the child). If the wrapper carries anything else
 * (padding/margin/sizing/position/…), removing its box would change layout, so the merge is unsafe.
 */
function outerMergeSafe(sm: StyleMap): boolean {
  const norm = normalizer.normalizeStyleMap(sm);
  for (const block of norm.blocks.values()) {
    for (const decl of block.decls.values()) {
      if (GRID_CONTAINER_PROPERTIES.has(String(decl.property))) continue;
      if (decl.inherited) continue;
      return false;
    }
  }
  return true;
}

/**
 * True iff the two containers disagree on any shared grid-container property (in any matching
 * condition) — e.g. `grid-template-columns:1fr` vs `1fr 1fr`. Such a conflict makes the merge
 * ambiguous, so the pattern skips.
 */
function gridConflict(outer: StyleMap, inner: StyleMap): boolean {
  const a = normalizer.normalizeStyleMap(outer);
  const b = normalizer.normalizeStyleMap(inner);
  for (const [key, blockA] of a.blocks) {
    const blockB = b.blocks.get(key);
    if (!blockB) continue;
    for (const [prop, declA] of blockA.decls) {
      if (!GRID_CONTAINER_PROPERTIES.has(String(prop))) continue;
      const declB = blockB.decls.get(prop);
      if (declB && declB.value !== declA.value) return true;
    }
  }
  return false;
}

/** Project the wrapper's transferable grid-container declarations into a fresh StyleMap. */
function extractGridStyle(sm: StyleMap): StyleMap {
  const blocks = new Map<ConditionKey, StyleBlock>();
  for (const [key, block] of sm.blocks) {
    const decls = new Map<CssProperty, StyleDecl>();
    for (const [prop, decl] of block.decls) {
      if (GRID_CONTAINER_PROPERTIES.has(String(prop))) decls.set(prop, decl);
    }
    if (decls.size > 0) blocks.set(key, { condition: block.condition, decls });
  }
  return { blocks };
}

/** The inner (surviving) grid container: also a grid `<div>`, and not a combinator subject (it is reparented). */
const isInnerGrid: Matcher = and(
  isElement('div'),
  computed(DISPLAY_GRID),
  not(targetedByCombinator),
);

/* ───────────────────────── the pattern ───────────────────────── */

/**
 * Flatten a grid container whose sole child is a compatible grid container into a single container.
 */
export const nestedGridMerge = definePattern({
  name: 'nested-grid-merge',
  category: 'flatten/nested-grid-merge',
  safety: 2,
  doc: {
    title: 'Merge nested grid containers',
    summary:
      'A grid container whose only child is itself a grid container with non-conflicting grid ' +
      'properties is collapsed into one; the wrapper is removed and its grid declarations merge ' +
      'onto the surviving child.',
    before:
      '<div style="display:grid;gap:8px">' +
      '<div style="display:grid;grid-template-columns:1fr 1fr"/></div>',
    after: '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"/>',
    safetyRationale:
      'The wrapper paints nothing, declares only grid-container/inheritable properties, carries no ' +
      'ref/handlers/dynamic children, and is not a combinator subject; the two containers do not ' +
      'conflict on any grid property, so the union is unambiguous and lossless.',
  },
  match: {
    tag: 'div',
    style: { display: 'grid' },
    onlyChild: 'element',
    paintsNothing: true,
  },
  rewrite: (ctx: MatchContext, rw: RewriteFactory): readonly RewriteOpDraft[] | null => {
    const outer = ctx.node;
    const inner = ctx.onlyElementChild();
    if (!inner) return null;
    if (!isInnerGrid(inner as unknown as NodeLike, ctx)) return null;

    const outerStyle = ctx.computed();
    const innerStyle = ctx.computedOf(inner as unknown as NodeLike);

    // The wrapper must carry nothing that would be lost when its box is removed …
    if (!outerMergeSafe(outerStyle)) return null;
    // … and the two containers must agree on every shared grid property.
    if (gridConflict(outerStyle, innerStyle)) return null;

    return [
      // 1. Preserve inheritable values (color/font/…) by folding them onto the child first.
      rw.foldInheritedStyles(outer, inner, { conditions: 'all' }),
      // 2. Transfer the wrapper's grid-container declarations onto the child (target-wins keeps the
      //    child's value for any shared property — identical anyway, we proved non-conflict).
      rw.mergeStyle(inner, null, extractGridStyle(outerStyle), 'target-wins'),
      // 3. Remove the wrapper (structural-safe; hoists the child and preserves its IRNodeId).
      rw.unwrap(outer),
    ];
  },
  // Like its flex sibling, this merge removes the outer container's box, but a `display:grid` wrapper
  // establishes a formatting context, so it is a `needs-verification` flatten that the conservative
  // production gate (`'provably-safe'`) REVERTS — every case here is a no-match. Op-level correctness
  // is asserted by the invariant suite over every pattern.
  test: {
    noMatch: [
      // The merge is real but not provably layout-neutral (the wrapper establishes a grid context),
      // so under the conservative gate the nested containers are left in place.
      '<div className="grid gap-2" data-x="1"><div className="grid grid-cols-2">X</div></div>',
      // A non-grid wrapper does not match the grid-container signature → left unchanged anyway.
      '<div className="block bg-blue-500"><div className="grid grid-cols-2">X</div></div>',
    ],
  },
});
