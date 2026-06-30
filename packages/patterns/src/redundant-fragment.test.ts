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
  createFragment,
  createNullResolver,
  createNullSelectorIndex,
  defaultMeta,
  getElement,
  runPasses,
} from '@domflax/core';
import { normalizer } from '@domflax/pattern-kit';

import { redundantFragment } from './flatten/redundant-fragment';

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

/** The surviving child paints its own background, so we can assert it was preserved verbatim. */
const CHILD_STYLE = styleMap([['background-color', 'red']]);

interface Tree {
  readonly doc: ReturnType<typeof createDocument>;
  readonly fragId: IRNodeId;
  readonly childId: IRNodeId;
}

/**
 * Assemble: <root-fragment> → <redundant fragment> → <child span (own style)>.
 *
 * `withKey` flips the fragment's `hasKey` opacity barrier (a keyed `<Fragment key>`) for the
 * negative case. Every node gets `safetyFloor: 3` so the safety-1 pattern's `unwrap` clears the
 * per-node floor — `createFragment` defaults to floor 0, so the fragment's meta is replaced.
 */
function buildTree(withKey = false): Tree {
  const doc = createDocument('jsx');
  const rootId = doc.root;
  const fragId = doc.alloc.next();
  const childId = doc.alloc.next();

  const child = createElement(childId, {
    tag: 'span',
    parent: fragId,
    computed: CHILD_STYLE,
    meta: defaultMeta(3),
  });

  const fragMeta = defaultMeta(3);
  fragMeta.hasKey = withKey;
  const fragment = createFragment(fragId, { parent: rootId, children: [childId] });
  fragment.meta = fragMeta;

  doc.nodes.set(fragId, fragment);
  doc.nodes.set(childId, child);
  (doc.nodes.get(rootId) as IRFragment).children = [fragId];

  return { doc, fragId, childId };
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
  { phase: 'flatten', category: 'flatten/redundant-fragment', patterns: [redundantFragment] },
];

/* ───────────────────────── tests ───────────────────────── */

describe('redundant-fragment', () => {
  it('is a well-formed flatten pattern', () => {
    expect(redundantFragment.category).toBe('flatten/redundant-fragment');
    expect(redundantFragment.safety).toBe(1);
    expect(typeof redundantFragment.evaluate).toBe('function');
  });

  it('flattens a single-child fragment into its sole child', () => {
    const { doc, fragId, childId } = buildTree();

    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));

    // the fragment is gone …
    expect(out.nodes.has(fragId)).toBe(false);

    // … the child survived (same IRNodeId) and was hoisted into the fragment's old slot …
    const child = getElement(out, childId);
    expect(child).toBeDefined();
    expect(child!.parent).toBe(out.root);
    expect((out.nodes.get(out.root) as IRFragment).children).toEqual([childId]);

    // … with its own styling untouched (no fold, no merge — fragments carry no style).
    const base = child!.computed.blocks.get(conditionKey(BASE_CONDITION));
    expect(base?.decls.get('background-color' as CssProperty)?.value).toBe('red');
  });

  it('does NOT flatten a keyed fragment (opacity barrier)', () => {
    const { doc, fragId, childId } = buildTree(true);

    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));

    // the keyed fragment is untouched; the child stays nested inside it.
    expect(out.nodes.has(fragId)).toBe(true);
    const fragment = out.nodes.get(fragId) as IRFragment;
    expect(fragment.children).toEqual([childId]);
    expect((out.nodes.get(out.root) as IRFragment).children).toEqual([fragId]);
  });

  it('does NOT flatten a fragment with more than one child (conflicting condition)', () => {
    const { doc, fragId, childId } = buildTree();

    // Add a second element child to the fragment — no longer "exactly one child".
    const siblingId = doc.alloc.next();
    const sibling = createElement(siblingId, {
      tag: 'span',
      parent: fragId,
      meta: defaultMeta(3),
    });
    doc.nodes.set(siblingId, sibling);
    (doc.nodes.get(fragId) as IRFragment).children = [childId, siblingId];

    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));

    expect(out.nodes.has(fragId)).toBe(true);
    expect((out.nodes.get(fragId) as IRFragment).children).toEqual([childId, siblingId]);
    expect((out.nodes.get(out.root) as IRFragment).children).toEqual([fragId]);
  });
});
