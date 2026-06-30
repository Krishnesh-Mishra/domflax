/**
 * Hand-built-IR unit test for the `place-shorthand` compress pattern.
 *
 * Build a single element whose computed StyleMap holds the alignment longhands, run the pattern
 * through `runPasses`, and assert the collapse at the IR level — a matching align/justify pair
 * becomes the corresponding `place-*` shorthand; a mismatched pair is left verbatim.
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

import { placeShorthand } from './place-shorthand.pattern';

/* ───────────────────────── fixtures ───────────────────────── */

const BASE_KEY: ConditionKey = conditionKey(BASE_CONDITION);

function styleMap(decls: readonly (readonly [string, string])[]): StyleMap {
  const map = new Map<CssProperty, StyleDecl>();
  for (const [prop, value] of decls) {
    for (const decl of normalizer.normalizeDeclaration(prop, value, false)) {
      map.set(decl.property, decl);
    }
  }
  const block: StyleBlock = { condition: BASE_CONDITION, decls: map };
  return { blocks: new Map<ConditionKey, StyleBlock>([[BASE_KEY, block]]) };
}

function buildDoc(computed: StyleMap): { doc: IRDocument; elId: IRNodeId } {
  const doc = createDocument('jsx');
  const elId = doc.alloc.next();
  const el = createElement(elId, {
    tag: 'div',
    parent: doc.root,
    computed,
    meta: defaultMeta(3),
  });
  doc.nodes.set(elId, el);
  (doc.nodes.get(doc.root) as IRFragment).children = [elId];
  return { doc, elId };
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
  { phase: 'compress', category: 'compress/place-shorthand', patterns: [placeShorthand] },
];

function runOn(computed: StyleMap): StyleBlock | undefined {
  const { doc, elId } = buildDoc(computed);
  const { doc: out } = runPasses(doc, PASSES, applyContext(doc));
  return getElement(out, elId)!.computed.blocks.get(BASE_KEY);
}

/* ───────────────────────── the suite ───────────────────────── */

describe('place-shorthand', () => {
  it('collapses a matching align-items/justify-items pair into `place-items`', () => {
    const base = runOn(
      styleMap([
        ['align-items', 'center'],
        ['justify-items', 'center'],
      ]),
    );

    expect(base).toBeDefined();
    expect(base!.decls.has('align-items' as CssProperty)).toBe(false);
    expect(base!.decls.has('justify-items' as CssProperty)).toBe(false);
    const placeItems = base!.decls.get('place-items' as CssProperty);
    expect(placeItems).toBeDefined();
    expect(placeItems!.value).toBe('center');
  });

  it('collapses a matching align-content/justify-content pair into `place-content`', () => {
    const base = runOn(
      styleMap([
        ['align-content', 'space-between'],
        ['justify-content', 'space-between'],
      ]),
    );

    expect(base).toBeDefined();
    expect(base!.decls.has('align-content' as CssProperty)).toBe(false);
    expect(base!.decls.has('justify-content' as CssProperty)).toBe(false);
    const placeContent = base!.decls.get('place-content' as CssProperty);
    expect(placeContent).toBeDefined();
    expect(placeContent!.value).toBe('space-between');
  });

  it('leaves a mismatched alignment pair (align-items != justify-items) untouched', () => {
    const base = runOn(
      styleMap([
        ['align-items', 'center'],
        ['justify-items', 'start'],
      ]),
    );

    expect(base).toBeDefined();
    expect(base!.decls.has('place-items' as CssProperty)).toBe(false);
    expect(base!.decls.get('align-items' as CssProperty)?.value).toBe('center');
    expect(base!.decls.get('justify-items' as CssProperty)?.value).toBe('start');
  });
});
