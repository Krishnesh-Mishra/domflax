/**
 * Hand-built-IR unit test for the `gap-shorthand` compress pattern.
 *
 * Mirrors the pattern-kit IR fixture style: build a single element whose computed StyleMap is the
 * NORMALIZED longhand basis (row-gap + column-gap), run the pattern through `runPasses`, and assert
 * the collapse at the IR level — the two axis longhands become one `gap` shorthand. The negative
 * case (unequal axes) must be left verbatim.
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

import { gapShorthand } from './gap-shorthand.pattern';

/* ───────────────────────── fixtures ───────────────────────── */

const BASE_KEY: ConditionKey = conditionKey(BASE_CONDITION);

/** Build a single-base-condition StyleMap from `[prop, value]` pairs via the shared normalizer. */
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
  { phase: 'compress', category: 'compress/gap-shorthand', patterns: [gapShorthand] },
];

function runOn(computed: StyleMap): StyleBlock | undefined {
  const { doc, elId } = buildDoc(computed);
  const { doc: out } = runPasses(doc, PASSES, applyContext(doc));
  return getElement(out, elId)!.computed.blocks.get(BASE_KEY);
}

/* ───────────────────────── the suite ───────────────────────── */

describe('gap-shorthand', () => {
  it('collapses an equal row-gap/column-gap pair into a single `gap` shorthand', () => {
    // Authoring `gap:1rem` exercises the normalizer's forward expansion into row/column-gap.
    const base = runOn(styleMap([['gap', '1rem']]));

    expect(base).toBeDefined();
    expect(base!.decls.has('row-gap' as CssProperty)).toBe(false);
    expect(base!.decls.has('column-gap' as CssProperty)).toBe(false);
    const gap = base!.decls.get('gap' as CssProperty);
    expect(gap).toBeDefined();
    expect(gap!.value).toBe('1rem');
  });

  it('leaves unequal axes (row-gap != column-gap) untouched', () => {
    const base = runOn(
      styleMap([
        ['row-gap', '0.5rem'],
        ['column-gap', '1rem'],
      ]),
    );

    expect(base).toBeDefined();
    expect(base!.decls.has('gap' as CssProperty)).toBe(false);
    expect(base!.decls.get('row-gap' as CssProperty)?.value).toBe('0.5rem');
    expect(base!.decls.get('column-gap' as CssProperty)?.value).toBe('1rem');
  });
});
