/**
 * Hand-built-IR unit test for the `scroll-padding-shorthand` compress pattern.
 *
 * Build a single element whose computed StyleMap holds the four scroll-padding longhands, run the
 * pattern through `runPasses`, and assert the collapse at the IR level — four equal sides become one
 * `scroll-padding` shorthand; mismatched sides are left verbatim.
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

import { scrollPaddingShorthand } from './scroll-padding-shorthand.pattern';

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
  {
    phase: 'compress',
    category: 'compress/scroll-padding-shorthand',
    patterns: [scrollPaddingShorthand],
  },
];

function runOn(computed: StyleMap): StyleBlock | undefined {
  const { doc, elId } = buildDoc(computed);
  const { doc: out } = runPasses(doc, PASSES, applyContext(doc));
  return getElement(out, elId)!.computed.blocks.get(BASE_KEY);
}

const SIDES = [
  'scroll-padding-top',
  'scroll-padding-right',
  'scroll-padding-bottom',
  'scroll-padding-left',
] as const;

/* ───────────────────────── the suite ───────────────────────── */

describe('scroll-padding-shorthand', () => {
  it('collapses four equal scroll-padding sides into a single `scroll-padding` shorthand', () => {
    const base = runOn(
      styleMap([
        ['scroll-padding-top', '1rem'],
        ['scroll-padding-right', '1rem'],
        ['scroll-padding-bottom', '1rem'],
        ['scroll-padding-left', '1rem'],
      ]),
    );

    expect(base).toBeDefined();
    for (const side of SIDES) {
      expect(base!.decls.has(side as CssProperty)).toBe(false);
    }
    const scrollPadding = base!.decls.get('scroll-padding' as CssProperty);
    expect(scrollPadding).toBeDefined();
    expect(scrollPadding!.value).toBe('1rem');
  });

  it('leaves mismatched sides (top != bottom) untouched', () => {
    const base = runOn(
      styleMap([
        ['scroll-padding-top', '2rem'],
        ['scroll-padding-right', '1rem'],
        ['scroll-padding-bottom', '1rem'],
        ['scroll-padding-left', '1rem'],
      ]),
    );

    expect(base).toBeDefined();
    expect(base!.decls.has('scroll-padding' as CssProperty)).toBe(false);
    expect(base!.decls.get('scroll-padding-top' as CssProperty)?.value).toBe('2rem');
    expect(base!.decls.get('scroll-padding-bottom' as CssProperty)?.value).toBe('1rem');
  });
});
