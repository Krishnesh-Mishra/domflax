import { describe, it, expect } from 'vitest';

import type {
  ApplyContext,
  ConditionKey,
  CssProperty,
  IRElement,
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

import { insetShorthand } from './compress/inset-shorthand';

/* ───────────────────────── hand-built IR fixtures (no resolver) ───────────────────────── */

/**
 * Build a single-(base-)condition StyleMap from `[property, value]` pairs via the shared
 * normalizer. Crucially, passing the `inset` shorthand lets the normalizer EXPAND it into the four
 * physical longhands — exactly the populated-`computed` state a real resolver would hand the pass.
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

interface Tree {
  readonly doc: ReturnType<typeof createDocument>;
  readonly elId: IRNodeId;
}

/**
 * Assemble: <root-fragment> → <div with the given computed style>.
 * `withHandler` flips the element's `hasEventHandlers` opacity barrier for the negative case.
 * The node gets `safetyFloor: 3` so the safety-2 pattern's op clears the per-node floor.
 */
function buildTree(computed: StyleMap, withHandler = false): Tree {
  const doc = createDocument('jsx');
  const rootId = doc.root;
  const elId = doc.alloc.next();

  const meta = defaultMeta(3);
  meta.hasEventHandlers = withHandler;
  const el = createElement(elId, { tag: 'div', parent: rootId, computed, meta });

  doc.nodes.set(elId, el);
  (doc.nodes.get(rootId) as IRFragment).children = [elId];

  return { doc, elId };
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
  { phase: 'compress', category: 'compress/inset-shorthand', patterns: [insetShorthand] },
];

function baseOf(el: IRElement): ReadonlyMap<CssProperty, StyleDecl> {
  return el.computed.blocks.get(conditionKey(BASE_CONDITION))!.decls;
}

const P = {
  top: 'top' as CssProperty,
  right: 'right' as CssProperty,
  bottom: 'bottom' as CssProperty,
  left: 'left' as CssProperty,
  inset: 'inset' as CssProperty,
  insetBlock: 'inset-block' as CssProperty,
  insetInline: 'inset-inline' as CssProperty,
};

/* ───────────────────────── tests ───────────────────────── */

describe('inset-shorthand', () => {
  it('declares the expected compress category', () => {
    expect(insetShorthand.category).toBe('compress/inset-shorthand');
    expect(insetShorthand.safety).toBe(2);
  });

  it('collapses four equal sides into a single `inset`', () => {
    // `inset:10px` → top/right/bottom/left all 10px.
    const { doc, elId } = buildTree(styleMap([['inset', '10px']]));

    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));

    const decls = baseOf(getElement(out, elId)!);
    expect(decls.get(P.inset)?.value).toBe('10px');
    // the four longhands are gone …
    for (const side of [P.top, P.right, P.bottom, P.left]) {
      expect(decls.has(side)).toBe(false);
    }
  });

  it('collapses matching pairs into `inset-block` / `inset-inline`', () => {
    // `inset:10px 20px` → top=bottom=10px, left=right=20px.
    const { doc, elId } = buildTree(styleMap([['inset', '10px 20px']]));

    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));

    const decls = baseOf(getElement(out, elId)!);
    expect(decls.get(P.insetBlock)?.value).toBe('10px'); // top/bottom
    expect(decls.get(P.insetInline)?.value).toBe('20px'); // left/right
    expect(decls.has(P.inset)).toBe(false); // not a single-value collapse
    for (const side of [P.top, P.right, P.bottom, P.left]) {
      expect(decls.has(side)).toBe(false);
    }
  });

  it('does NOT compress an element with an event handler (opacity barrier)', () => {
    const { doc, elId } = buildTree(styleMap([['inset', '10px']]), /* withHandler */ true);

    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));

    const decls = baseOf(getElement(out, elId)!);
    // barrier ⇒ longhands stay, no shorthand is synthesized.
    expect(decls.has(P.inset)).toBe(false);
    expect(decls.get(P.top)?.value).toBe('10px');
    expect(decls.get(P.right)?.value).toBe('10px');
    expect(decls.get(P.bottom)?.value).toBe('10px');
    expect(decls.get(P.left)?.value).toBe('10px');
  });

  it('does NOT compress when all four sides conflict (no equal pair)', () => {
    // `inset:10px 20px 30px 40px` → top=10,right=20,bottom=30,left=40: no pair matches.
    const { doc, elId } = buildTree(styleMap([['inset', '10px 20px 30px 40px']]));

    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));

    const decls = baseOf(getElement(out, elId)!);
    expect(decls.has(P.inset)).toBe(false);
    expect(decls.has(P.insetBlock)).toBe(false);
    expect(decls.has(P.insetInline)).toBe(false);
    expect(decls.get(P.top)?.value).toBe('10px');
    expect(decls.get(P.right)?.value).toBe('20px');
    expect(decls.get(P.bottom)?.value).toBe('30px');
    expect(decls.get(P.left)?.value).toBe('40px');
  });
});
