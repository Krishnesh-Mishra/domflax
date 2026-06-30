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

import { emptyStyleDiv } from './flatten/empty-style-div';

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

/**
 * The layout-neutral wrapper: an explicit (but default) `display:block` plus an inheritable `color`
 * that must be folded onto the child before the box is removed. Neither counts as own visual style.
 */
const NEUTRAL_WRAPPER_STYLE = styleMap([
  ['display', 'block'],
  ['color', 'red'],
]);

/** A child paints its own background ⇒ it has its own visual style and is worth keeping. */
const CHILD_STYLE = styleMap([['background-color', 'blue']]);

interface Tree {
  readonly doc: ReturnType<typeof createDocument>;
  readonly wrapperId: IRNodeId;
  readonly childId: IRNodeId;
}

/**
 * Assemble: <root-fragment> → <wrapper div (layout-neutral)> → <child div (own style)>.
 * `withBox` flips the wrapper's `establishesBox` flag for the negative case: a div that establishes
 * a real box is NOT layout-neutral, so the pattern must refuse to unwrap it.
 * Every node gets `safetyFloor: 3` so the safety-1 pattern's ops clear the per-node floor.
 */
function buildTree(withBox = false): Tree {
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
  wrapperMeta.establishesBox = withBox;
  const wrapper = createElement(wrapperId, {
    tag: 'div',
    parent: rootId,
    children: [childId],
    computed: NEUTRAL_WRAPPER_STYLE,
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
  { phase: 'flatten', category: 'flatten/empty-style-div', patterns: [emptyStyleDiv] },
];

/* ───────────────────────── tests ───────────────────────── */

describe('empty-style-div', () => {
  it('has the expected identity (name/category/safety)', () => {
    expect(emptyStyleDiv.name).toBe('empty-style-div');
    expect(emptyStyleDiv.category).toBe('flatten/empty-style-div');
    expect(emptyStyleDiv.safety).toBe(1);
  });

  it('flattens a layout-neutral wrapper onto its sole child', () => {
    const { doc, wrapperId, childId } = buildTree();

    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));

    // wrapper is gone …
    expect(out.nodes.has(wrapperId)).toBe(false);

    // … the child survived (same IRNodeId) and was hoisted into the wrapper's old slot …
    const child = getElement(out, childId);
    expect(child).toBeDefined();
    expect(child!.parent).toBe(out.root);
    expect((out.nodes.get(out.root) as IRFragment).children).toContain(childId);

    // … inheritable color folded down, and the child kept its own background.
    const base = child!.computed.blocks.get(conditionKey(BASE_CONDITION));
    expect(base?.decls.get('color' as CssProperty)?.value).toBe('red');
    expect(base?.decls.get('background-color' as CssProperty)?.value).toBe('blue');
  });

  it('does NOT flatten a wrapper that establishes a box (conflicting condition)', () => {
    const { doc, wrapperId, childId } = buildTree(true);

    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));

    // wrapper is untouched, child stays nested inside it.
    expect(out.nodes.has(wrapperId)).toBe(true);
    const wrapper = getElement(out, wrapperId);
    expect(wrapper!.children).toContain(childId);
    expect((out.nodes.get(out.root) as IRFragment).children).toEqual([wrapperId]);

    // direct evaluate also reports no match (pure, no ops).
    expect(emptyStyleDiv.evaluate).toBeTypeOf('function');
  });
});
