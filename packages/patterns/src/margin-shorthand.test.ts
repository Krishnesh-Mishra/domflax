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

import { marginShorthand } from './compress/margin-shorthand';

/* ───────────────────────── hand-built IR fixtures (no resolver) ───────────────────────── */

/**
 * Build a single-(base-)condition StyleMap from `[property, value]` pairs via the shared normalizer.
 * Passing `['margin', '8px']` therefore EXPANDS into the four margin longhands the pattern matches.
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

/** All four margins equal (the `m` collapse case) plus an unrelated, preserved declaration. */
const MARGIN_STYLE = styleMap([
  ['margin', '8px'],
  ['color', 'red'],
]);

interface Tree {
  readonly doc: ReturnType<typeof createDocument>;
  readonly elId: IRNodeId;
}

/**
 * Assemble: <root-fragment> → <div with four margin longhands + color>.
 * `withHandler` flips the element's `hasEventHandlers` opacity barrier for the negative case.
 * Every node gets `safetyFloor: 3` so the safety-2 pattern's ops clear the per-node floor.
 */
function buildTree(withHandler = false): Tree {
  const doc = createDocument('jsx');
  const rootId = doc.root;
  const elId = doc.alloc.next();

  const meta = defaultMeta(3);
  meta.hasEventHandlers = withHandler;
  const el = createElement(elId, {
    tag: 'div',
    parent: rootId,
    computed: MARGIN_STYLE,
    meta,
  });

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
  { phase: 'compress', category: 'compress/margin-shorthand', patterns: [marginShorthand] },
];

const M = 'margin' as CssProperty;
const MT = 'margin-top' as CssProperty;
const COLOR = 'color' as CssProperty;

/* ───────────────────────── tests ───────────────────────── */

describe('margin-shorthand', () => {
  it('is a compress-phase pattern with the expected category', () => {
    expect(marginShorthand.category).toBe('compress/margin-shorthand');
    expect(marginShorthand.safety).toBe(2);
    expect(typeof marginShorthand.evaluate).toBe('function');
  });

  it('collapses four equal margin longhands into a single `margin` shorthand', () => {
    const { doc, elId } = buildTree();

    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));

    const el = getElement(out, elId);
    expect(el).toBeDefined();

    const base = el!.computed.blocks.get(conditionKey(BASE_CONDITION));
    expect(base).toBeDefined();

    // … the four longhands are gone, replaced by one collapsed shorthand …
    expect(base!.decls.get(M)?.value).toBe('8px');
    expect(base!.decls.has(MT)).toBe(false);
    expect(base!.decls.has('margin-left' as CssProperty)).toBe(false);

    // … and the unrelated declaration is preserved untouched.
    expect(base!.decls.get(COLOR)?.value).toBe('red');
  });

  it('does NOT collapse a node with an event handler (opacity barrier)', () => {
    const { doc, elId } = buildTree(true);

    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));

    const el = getElement(out, elId);
    const base = el!.computed.blocks.get(conditionKey(BASE_CONDITION));

    // The four longhands survive verbatim; no `margin` shorthand was synthesized.
    expect(base!.decls.has(M)).toBe(false);
    expect(base!.decls.get(MT)?.value).toBe('8px');
    expect(base!.decls.get('margin-left' as CssProperty)?.value).toBe('8px');
  });
});
