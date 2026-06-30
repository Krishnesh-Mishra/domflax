/**
 * Hand-built-IR unit test for the `scroll-margin-shorthand` compress pattern.
 *
 * Build a single element whose computed StyleMap holds the four scroll-margin longhands, run the
 * pattern through `runPasses`, and assert the collapse at the IR level — four equal sides become one
 * `scroll-margin` shorthand; mismatched sides are left verbatim.
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

import { scrollMarginShorthand } from './scroll-margin-shorthand.pattern';

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
  { phase: 'compress', category: 'compress/scroll-margin-shorthand', patterns: [scrollMarginShorthand] },
];

function runOn(computed: StyleMap): StyleBlock | undefined {
  const { doc, elId } = buildDoc(computed);
  const { doc: out } = runPasses(doc, PASSES, applyContext(doc));
  return getElement(out, elId)!.computed.blocks.get(BASE_KEY);
}

const SIDES = [
  'scroll-margin-top',
  'scroll-margin-right',
  'scroll-margin-bottom',
  'scroll-margin-left',
] as const;

/* ───────────────────────── the suite ───────────────────────── */

describe('scroll-margin-shorthand', () => {
  it('collapses four equal scroll-margin sides into a single `scroll-margin` shorthand', () => {
    const base = runOn(
      styleMap([
        ['scroll-margin-top', '1rem'],
        ['scroll-margin-right', '1rem'],
        ['scroll-margin-bottom', '1rem'],
        ['scroll-margin-left', '1rem'],
      ]),
    );

    expect(base).toBeDefined();
    for (const side of SIDES) {
      expect(base!.decls.has(side as CssProperty)).toBe(false);
    }
    const scrollMargin = base!.decls.get('scroll-margin' as CssProperty);
    expect(scrollMargin).toBeDefined();
    expect(scrollMargin!.value).toBe('1rem');
  });

  it('leaves mismatched sides (top != bottom) untouched', () => {
    const base = runOn(
      styleMap([
        ['scroll-margin-top', '2rem'],
        ['scroll-margin-right', '1rem'],
        ['scroll-margin-bottom', '1rem'],
        ['scroll-margin-left', '1rem'],
      ]),
    );

    expect(base).toBeDefined();
    expect(base!.decls.has('scroll-margin' as CssProperty)).toBe(false);
    expect(base!.decls.get('scroll-margin-top' as CssProperty)?.value).toBe('2rem');
    expect(base!.decls.get('scroll-margin-bottom' as CssProperty)?.value).toBe('1rem');
  });
});
