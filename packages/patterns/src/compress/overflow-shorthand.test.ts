/**
 * Hand-built-IR unit test for the `overflow-shorthand` compress pattern.
 *
 * Build a single element whose computed StyleMap holds the two overflow axis longhands, run the
 * pattern through `runPasses`, and assert the collapse at the IR level — equal axes become one
 * `overflow` shorthand; mismatched axes are left verbatim.
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

import { overflowShorthand } from './overflow-shorthand.pattern';

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
  { phase: 'compress', category: 'compress/overflow-shorthand', patterns: [overflowShorthand] },
];

function runOn(computed: StyleMap): StyleBlock | undefined {
  const { doc, elId } = buildDoc(computed);
  const { doc: out } = runPasses(doc, PASSES, applyContext(doc));
  return getElement(out, elId)!.computed.blocks.get(BASE_KEY);
}

/* ───────────────────────── the suite ───────────────────────── */

describe('overflow-shorthand', () => {
  it('collapses an equal overflow-x/overflow-y pair into a single `overflow` shorthand', () => {
    const base = runOn(
      styleMap([
        ['overflow-x', 'auto'],
        ['overflow-y', 'auto'],
      ]),
    );

    expect(base).toBeDefined();
    expect(base!.decls.has('overflow-x' as CssProperty)).toBe(false);
    expect(base!.decls.has('overflow-y' as CssProperty)).toBe(false);
    const overflow = base!.decls.get('overflow' as CssProperty);
    expect(overflow).toBeDefined();
    expect(overflow!.value).toBe('auto');
  });

  it('leaves mismatched axes (overflow-x != overflow-y) untouched', () => {
    const base = runOn(
      styleMap([
        ['overflow-x', 'auto'],
        ['overflow-y', 'hidden'],
      ]),
    );

    expect(base).toBeDefined();
    expect(base!.decls.has('overflow' as CssProperty)).toBe(false);
    expect(base!.decls.get('overflow-x' as CssProperty)?.value).toBe('auto');
    expect(base!.decls.get('overflow-y' as CssProperty)?.value).toBe('hidden');
  });
});
