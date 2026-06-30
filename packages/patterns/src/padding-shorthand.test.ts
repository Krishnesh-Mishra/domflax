import { describe, it, expect } from 'vitest';

import type {
  ApplyContext,
  ConditionKey,
  CssProperty,
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

import { paddingShorthand } from './compress/padding-shorthand';

/* ───────────────────────── hand-built IR fixtures (no resolver) ───────────────────────── */

/**
 * Build a single-(base-)condition StyleMap from `[property, value]` pairs via the shared normalizer.
 * Passing a box shorthand (e.g. `['padding','16px']`) expands to the four longhands — exactly the
 * canonical LONGHAND computed shape this compress pattern folds back up.
 */
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

const BASE_KEY = conditionKey(BASE_CONDITION);
const PADDING = 'padding' as CssProperty;

interface Tree {
  readonly doc: ReturnType<typeof createDocument>;
  readonly boxId: IRNodeId;
}

/**
 * Assemble: <root-fragment> → <box div (padding longhands)>.
 * `withRef` flips the box's `hasRef` opacity barrier for the negative case.
 * Every node gets `safetyFloor: 3` so the safety-1 pattern's ops clear the per-node floor.
 */
function buildTree(boxStyle: StyleMap, withRef = false): Tree {
  const doc = createDocument('jsx');
  const rootId = doc.root;
  const boxId = doc.alloc.next();

  const meta = defaultMeta(3);
  meta.hasRef = withRef;
  const box = createElement(boxId, {
    tag: 'div',
    parent: rootId,
    computed: boxStyle,
    meta,
  });

  doc.nodes.set(boxId, box);
  (doc.nodes.get(rootId) as IRFragment).children = [boxId];

  return { doc, boxId };
}

function applyContext(doc: ReturnType<typeof createDocument>): ApplyContext {
  return {
    doc,
    safetyCeiling: 3,
    normalizer,
    selectors: createNullSelectorIndex(),
    resolver: createNullResolver(),
  };
}

const PASSES: readonly Pass[] = [
  { phase: 'compress', category: 'compress/padding-shorthand', patterns: [paddingShorthand] },
];

/** The BASE-condition decl map of an element after a run. */
function baseDecls(doc: ReturnType<typeof createDocument>, id: IRNodeId) {
  return getElement(doc, id)!.computed.blocks.get(BASE_KEY)!.decls;
}

/* ───────────────────────── tests ───────────────────────── */

describe('padding-shorthand', () => {
  it('is a compress pattern with the expected category/safety', () => {
    expect(paddingShorthand.category).toBe('compress/padding-shorthand');
    expect(paddingShorthand.safety).toBe(1);
    expect(typeof paddingShorthand.evaluate).toBe('function');
  });

  it('collapses four equal padding longhands into a single `padding` shorthand (p-*)', () => {
    // `['padding','16px']` normalizes to four equal longhands — the canonical computed shape.
    const { doc, boxId } = buildTree(styleMap([['padding', '16px']]));

    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));

    const decls = baseDecls(out, boxId);
    // the four longhands are gone …
    expect(decls.has('padding-top' as CssProperty)).toBe(false);
    expect(decls.has('padding-right' as CssProperty)).toBe(false);
    expect(decls.has('padding-bottom' as CssProperty)).toBe(false);
    expect(decls.has('padding-left' as CssProperty)).toBe(false);
    // … replaced by one shorthand decl.
    expect(decls.get(PADDING)?.value).toBe('16px');
  });

  it('collapses matching x/y pairs into a two-value `padding` shorthand (px-* py-*)', () => {
    // top/bottom = 8px, left/right = 16px.
    const { doc, boxId } = buildTree(styleMap([['padding', '8px 16px']]));

    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));

    const decls = baseDecls(out, boxId);
    expect(decls.has('padding-top' as CssProperty)).toBe(false);
    expect(decls.get(PADDING)?.value).toBe('8px 16px');
  });

  it('preserves unrelated declarations while folding the padding', () => {
    const { doc, boxId } = buildTree(
      styleMap([
        ['padding', '16px'],
        ['color', 'red'],
      ]),
    );

    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));

    const decls = baseDecls(out, boxId);
    expect(decls.get(PADDING)?.value).toBe('16px');
    expect(decls.get('color' as CssProperty)?.value).toBe('red');
  });

  it('does NOT collapse a node with a ref (opacity barrier)', () => {
    const { doc, boxId } = buildTree(styleMap([['padding', '16px']]), /* withRef */ true);

    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));

    const decls = baseDecls(out, boxId);
    // longhands remain, no shorthand introduced.
    expect(decls.has('padding-top' as CssProperty)).toBe(true);
    expect(decls.has('padding-left' as CssProperty)).toBe(true);
    expect(decls.has(PADDING)).toBe(false);
  });

  it('does NOT collapse asymmetric padding (conflicting sides)', () => {
    // top=16px, bottom=4px → no clean x/y fold.
    const { doc, boxId } = buildTree(
      styleMap([
        ['padding-top', '16px'],
        ['padding-right', '8px'],
        ['padding-bottom', '4px'],
        ['padding-left', '8px'],
      ]),
    );

    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));

    const decls = baseDecls(out, boxId);
    expect(decls.has(PADDING)).toBe(false);
    expect(decls.get('padding-top' as CssProperty)?.value).toBe('16px');
    expect(decls.get('padding-bottom' as CssProperty)?.value).toBe('4px');
  });
});
