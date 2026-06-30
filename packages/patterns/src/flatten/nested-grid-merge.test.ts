/**
 * @domflax/patterns — hand-built-IR test for the `nested-grid-merge` flatten pattern.
 *
 * Builds an outer grid `<div>` whose sole element child is an inner grid `<div>`, drives the pattern
 * through `runPasses`, and asserts the two containers merge into one on the positive case and stay
 * untouched when the wrapper carries a non-transferable style, the two grids conflict, or the child
 * is not a grid container.
 */

import type {
  ApplyContext,
  ConditionKey,
  CssProperty,
  IRDocument,
  IRFragment,
  IRNodeId,
  Pass,
  StyleBlock,
  StyleDecl,
  StyleMap,
} from '@domflax/core';
import {
  BASE_CONDITION,
  conditionKey,
  createDocument,
  createElement,
  createNullResolver,
  createNullSelectorIndex,
  defaultMeta,
  getElement,
  runPasses,
} from '@domflax/core';
import { normalizer } from '@domflax/pattern-kit';

import { describe, expect, it } from 'vitest';

import { nestedGridMerge } from './nested-grid-merge.pattern';

/* ───────────────────────── fixtures ───────────────────────── */

function styleMap(decls: readonly (readonly [string, string])[]): StyleMap {
  const map = new Map<CssProperty, StyleDecl>();
  for (const [prop, value] of decls) {
    for (const decl of normalizer.normalizeDeclaration(prop, value, false)) {
      map.set(decl.property, decl);
    }
  }
  const block: StyleBlock = { condition: BASE_CONDITION, decls: map };
  return { blocks: new Map<ConditionKey, StyleBlock>([[conditionKey(BASE_CONDITION), block]]) };
}

function buildTree(
  outerStyle: readonly (readonly [string, string])[],
  innerStyle: readonly (readonly [string, string])[],
): { doc: IRDocument; outerId: IRNodeId; innerId: IRNodeId } {
  const doc = createDocument('jsx');
  const rootId = doc.root;
  const outerId = doc.alloc.next();
  const innerId = doc.alloc.next();

  const inner = createElement(innerId, {
    tag: 'div',
    parent: outerId,
    computed: styleMap(innerStyle),
    meta: defaultMeta(3),
  });
  const outer = createElement(outerId, {
    tag: 'div',
    parent: rootId,
    children: [innerId],
    computed: styleMap(outerStyle),
    meta: defaultMeta(3),
  });

  doc.nodes.set(outerId, outer);
  doc.nodes.set(innerId, inner);
  (doc.nodes.get(rootId) as IRFragment).children = [outerId];
  return { doc, outerId, innerId };
}

function applyContext(doc: IRDocument): ApplyContext {
  return {
    doc,
    safetyCeiling: 3,
    normalizer,
    selectors: createNullSelectorIndex(),
    resolver: createNullResolver(),
  };
}

const PASSES: readonly Pass[] = [
  { phase: 'flatten', category: 'flatten/nested-grid-merge', patterns: [nestedGridMerge] },
];

/* ───────────────────────── the suite ───────────────────────── */

describe('flatten/nested-grid-merge', () => {
  it('merges a grid wrapper into a compatible inner grid container', () => {
    const { doc, outerId, innerId } = buildTree(
      [['display', 'grid'], ['gap', '8px']],
      [['display', 'grid'], ['grid-template-columns', '1fr 1fr']],
    );
    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));

    // Outer removed, inner hoisted into its slot.
    expect(out.nodes.has(outerId)).toBe(false);
    const inner = getElement(out, innerId);
    expect(inner).toBeDefined();
    expect(inner!.parent).toBe(out.root);
    expect((out.nodes.get(out.root) as IRFragment).children).toEqual([innerId]);

    // The wrapper's grid declarations (gap → row/column-gap) merged onto the surviving child,
    // alongside the child's own grid-template-columns.
    const base = inner!.computed.blocks.get(conditionKey(BASE_CONDITION));
    expect(base?.decls.get('display' as CssProperty)?.value).toBe('grid');
    expect(base?.decls.get('grid-template-columns' as CssProperty)).toBeDefined();
    expect(base?.decls.get('row-gap' as CssProperty)).toBeDefined();
    expect(base?.decls.get('column-gap' as CssProperty)).toBeDefined();
  });

  it('keeps both when the wrapper carries a non-transferable style (padding)', () => {
    const { doc, outerId, innerId } = buildTree(
      [['display', 'grid'], ['padding-top', '10px']],
      [['display', 'grid'], ['grid-template-columns', '1fr 1fr']],
    );
    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));
    expect(out.nodes.has(outerId)).toBe(true);
    expect(getElement(out, outerId)!.children).toContain(innerId);
  });

  it('keeps both when the two grids conflict on a shared property', () => {
    const { doc, outerId } = buildTree(
      [['display', 'grid'], ['grid-template-columns', '1fr']],
      [['display', 'grid'], ['grid-template-columns', '1fr 1fr']],
    );
    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));
    expect(out.nodes.has(outerId)).toBe(true);
  });

  it('does not match when the sole child is not a grid container', () => {
    const { doc, outerId } = buildTree(
      [['display', 'grid'], ['gap', '8px']],
      [['display', 'block']],
    );
    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));
    expect(out.nodes.has(outerId)).toBe(true);
  });
});
