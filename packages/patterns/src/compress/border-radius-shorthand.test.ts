/**
 * Hand-built-IR unit test for the `border-radius-shorthand` compress pattern.
 *
 * Build a single element whose computed StyleMap holds the four corner-radius longhands, run the
 * pattern through `runPasses`, and assert the collapse at the IR level — four equal corners become
 * one `border-radius` shorthand; mismatched corners are left verbatim.
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

import { borderRadiusShorthand } from './border-radius-shorthand.pattern';

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
  { phase: 'compress', category: 'compress/border-radius-shorthand', patterns: [borderRadiusShorthand] },
];

function runOn(computed: StyleMap): StyleBlock | undefined {
  const { doc, elId } = buildDoc(computed);
  const { doc: out } = runPasses(doc, PASSES, applyContext(doc));
  return getElement(out, elId)!.computed.blocks.get(BASE_KEY);
}

const CORNERS = [
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
] as const;

/* ───────────────────────── the suite ───────────────────────── */

describe('border-radius-shorthand', () => {
  it('collapses four equal corner radii into a single `border-radius` shorthand', () => {
    const base = runOn(
      styleMap([
        ['border-top-left-radius', '0.5rem'],
        ['border-top-right-radius', '0.5rem'],
        ['border-bottom-right-radius', '0.5rem'],
        ['border-bottom-left-radius', '0.5rem'],
      ]),
    );

    expect(base).toBeDefined();
    for (const corner of CORNERS) {
      expect(base!.decls.has(corner as CssProperty)).toBe(false);
    }
    const radius = base!.decls.get('border-radius' as CssProperty);
    expect(radius).toBeDefined();
    expect(radius!.value).toBe('0.5rem');
  });

  it('leaves mismatched corners (one corner differs) untouched', () => {
    const base = runOn(
      styleMap([
        ['border-top-left-radius', '0.5rem'],
        ['border-top-right-radius', '0.5rem'],
        ['border-bottom-right-radius', '0.25rem'],
        ['border-bottom-left-radius', '0.5rem'],
      ]),
    );

    expect(base).toBeDefined();
    expect(base!.decls.has('border-radius' as CssProperty)).toBe(false);
    expect(base!.decls.get('border-top-left-radius' as CssProperty)?.value).toBe('0.5rem');
    expect(base!.decls.get('border-bottom-right-radius' as CssProperty)?.value).toBe('0.25rem');
  });
});
