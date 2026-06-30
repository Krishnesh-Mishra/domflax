/**
 * Hand-built-IR unit test for the `border-shorthand` compress pattern.
 *
 * Build a single element whose computed StyleMap holds the four border-width longhands, run the
 * pattern through `runPasses`, and assert the collapse at the IR level — equal/paired widths become
 * one `border-width` shorthand; asymmetric widths are left verbatim.
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

import { borderShorthand } from './border-shorthand.pattern';

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
  { phase: 'compress', category: 'compress/border-shorthand', patterns: [borderShorthand] },
];

function runOn(computed: StyleMap): StyleBlock | undefined {
  const { doc, elId } = buildDoc(computed);
  const { doc: out } = runPasses(doc, PASSES, applyContext(doc));
  return getElement(out, elId)!.computed.blocks.get(BASE_KEY);
}

const SIDES = [
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
] as const;

/* ───────────────────────── the suite ───────────────────────── */

describe('border-shorthand', () => {
  it('collapses four equal border widths into a single `border-width` shorthand', () => {
    const base = runOn(
      styleMap([
        ['border-top-width', '2px'],
        ['border-right-width', '2px'],
        ['border-bottom-width', '2px'],
        ['border-left-width', '2px'],
      ]),
    );

    expect(base).toBeDefined();
    for (const side of SIDES) {
      expect(base!.decls.has(side as CssProperty)).toBe(false);
    }
    const width = base!.decls.get('border-width' as CssProperty);
    expect(width).toBeDefined();
    expect(width!.value).toBe('2px');
  });

  it('folds matching x/y pairs into a 2-value `border-width` shorthand', () => {
    const base = runOn(
      styleMap([
        ['border-top-width', '2px'],
        ['border-bottom-width', '2px'],
        ['border-left-width', '4px'],
        ['border-right-width', '4px'],
      ]),
    );

    expect(base).toBeDefined();
    const width = base!.decls.get('border-width' as CssProperty);
    expect(width).toBeDefined();
    // CSS shorthand order is `<y> <x>` (top/bottom, then left/right).
    expect(width!.value).toBe('2px 4px');
  });

  it('leaves asymmetric widths (top != bottom) untouched', () => {
    const base = runOn(
      styleMap([
        ['border-top-width', '2px'],
        ['border-right-width', '4px'],
        ['border-bottom-width', '8px'],
        ['border-left-width', '4px'],
      ]),
    );

    expect(base).toBeDefined();
    expect(base!.decls.has('border-width' as CssProperty)).toBe(false);
    expect(base!.decls.get('border-top-width' as CssProperty)?.value).toBe('2px');
    expect(base!.decls.get('border-bottom-width' as CssProperty)?.value).toBe('8px');
  });
});
