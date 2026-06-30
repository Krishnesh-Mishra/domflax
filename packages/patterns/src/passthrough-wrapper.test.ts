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

import { passthroughWrapper } from './flatten/passthrough-wrapper';

/* ───────────────────────── hand-built IR fixtures (no resolver) ───────────────────────── */

/** Build a single-(base-)condition StyleMap from `[property, value]` pairs via the shared normalizer. */
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

/** The wrapper carries ONLY an inheritable text style — no paint, no box: a pure passthrough. */
const WRAPPER_INHERITABLE = styleMap([['color', 'red']]);

/** A child paints its own background ⇒ it survives and is worth keeping. */
const CHILD_STYLE = styleMap([['background-color', 'blue']]);

/** A wrapper that paints its own background ⇒ NOT a passthrough (has own visual style). */
const WRAPPER_VISUAL = styleMap([['background-color', 'green']]);

interface Tree {
  readonly doc: ReturnType<typeof createDocument>;
  readonly wrapperId: IRNodeId;
  readonly childId: IRNodeId;
}

type Barrier = 'none' | 'ref' | 'visual';

/**
 * Assemble: <root-fragment> → <wrapper div> → <child div (own style)>.
 *   • `'ref'`    flips the wrapper's `hasRef` opacity barrier (negative case);
 *   • `'visual'` gives the wrapper its own paint (conflicting condition, negative case).
 * Every node gets `safetyFloor: 3` so the safety-2 pattern's ops clear the per-node floor.
 */
function buildTree(barrier: Barrier = 'none'): Tree {
  const doc = createDocument('jsx');
  const rootId = doc.root;
  const wrapperId = doc.alloc.next();
  const childId = doc.alloc.next();

  const child = createElement(childId, {
    tag: 'div',
    parent: wrapperId,
    computed: CHILD_STYLE,
    meta: defaultMeta(3),
  });

  const wrapperMeta = defaultMeta(3);
  wrapperMeta.hasRef = barrier === 'ref';
  const wrapper = createElement(wrapperId, {
    tag: 'div',
    parent: rootId,
    children: [childId],
    computed: barrier === 'visual' ? WRAPPER_VISUAL : WRAPPER_INHERITABLE,
    meta: wrapperMeta,
  });

  doc.nodes.set(wrapperId, wrapper);
  doc.nodes.set(childId, child);
  (doc.nodes.get(rootId) as IRFragment).children = [wrapperId];

  return { doc, wrapperId, childId };
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
  { phase: 'flatten', category: 'flatten/passthrough-wrapper', patterns: [passthroughWrapper] },
];

/* ───────────────────────── tests ───────────────────────── */

describe('passthrough-wrapper', () => {
  it('has the expected identity', () => {
    expect(passthroughWrapper.name).toBe('passthrough-wrapper');
    expect(passthroughWrapper.category).toBe('flatten/passthrough-wrapper');
    expect(passthroughWrapper.safety).toBe(2);
  });

  it('removes a do-nothing wrapper and hoists its sole child (folding inheritable styles)', () => {
    const { doc, wrapperId, childId } = buildTree();

    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));

    // wrapper is gone …
    expect(out.nodes.has(wrapperId)).toBe(false);

    // … the child survived (same IRNodeId) and was hoisted into the wrapper's old slot …
    const child = getElement(out, childId);
    expect(child).toBeDefined();
    expect(child!.parent).toBe(out.root);
    expect((out.nodes.get(out.root) as IRFragment).children).toEqual([childId]);

    // … it kept its own background and inherited the wrapper's color via the fold.
    const base = child!.computed.blocks.get(conditionKey(BASE_CONDITION));
    expect(base?.decls.get('background-color' as CssProperty)?.value).toBe('blue');
    expect(base?.decls.get('color' as CssProperty)?.value).toBe('red');
  });

  it('does NOT flatten a wrapper that carries a ref (opacity barrier)', () => {
    const { doc, wrapperId, childId } = buildTree('ref');

    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));

    // wrapper is untouched, child stays nested inside it.
    expect(out.nodes.has(wrapperId)).toBe(true);
    const wrapper = getElement(out, wrapperId);
    expect(wrapper!.children).toContain(childId);
    expect((out.nodes.get(out.root) as IRFragment).children).toEqual([wrapperId]);
  });

  it('does NOT flatten a wrapper with its own visual style (conflicting condition)', () => {
    const { doc, wrapperId, childId } = buildTree('visual');

    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));

    expect(out.nodes.has(wrapperId)).toBe(true);
    const wrapper = getElement(out, wrapperId);
    expect(wrapper!.children).toEqual([childId]);

    // evaluate is the single pure entry point (no match ⇒ no ops were scheduled above).
    expect(typeof passthroughWrapper.evaluate).toBe('function');
  });
});
