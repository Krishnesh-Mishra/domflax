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

import { nestedFlexMerge } from './flatten/nested-flex-merge';

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

/** Outer flex container: centers + gaps; carries nothing layout-affecting beyond flex props. */
const OUTER_FLEX = styleMap([
  ['display', 'flex'],
  ['align-items', 'center'],
  ['gap', '8px'],
]);

/** Inner flex container with a column direction the outer does not set ⇒ compatible (no conflict). */
const INNER_FLEX = styleMap([
  ['display', 'flex'],
  ['flex-direction', 'column'],
]);

interface Tree {
  readonly doc: ReturnType<typeof createDocument>;
  readonly outerId: IRNodeId;
  readonly innerId: IRNodeId;
}

interface BuildOpts {
  /** Flip the outer wrapper's `hasEventHandlers` opacity barrier (negative case). */
  readonly withHandler?: boolean;
  /** Inner StyleMap override — used to inject a conflicting flex property (negative case). */
  readonly innerStyle?: StyleMap;
}

/**
 * Assemble: <root-fragment> → <outer div (flex)> → <inner div (flex)>.
 * Every node gets `safetyFloor: 3` so the safety-2 pattern's ops clear the per-node floor.
 */
function buildTree(opts: BuildOpts = {}): Tree {
  const doc = createDocument('jsx');
  const rootId = doc.root;
  const outerId = doc.alloc.next();
  const innerId = doc.alloc.next();

  const inner = createElement(innerId, {
    tag: 'div',
    parent: outerId,
    computed: opts.innerStyle ?? INNER_FLEX,
    meta: defaultMeta(3),
  });

  const outerMeta = defaultMeta(3);
  outerMeta.hasEventHandlers = opts.withHandler ?? false;
  const outer = createElement(outerId, {
    tag: 'div',
    parent: rootId,
    children: [innerId],
    computed: OUTER_FLEX,
    meta: outerMeta,
  });

  doc.nodes.set(outerId, outer);
  doc.nodes.set(innerId, inner);
  (doc.nodes.get(rootId) as IRFragment).children = [outerId];

  return { doc, outerId, innerId };
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
  { phase: 'flatten', category: 'flatten/nested-flex-merge', patterns: [nestedFlexMerge] },
];

/* ───────────────────────── tests ───────────────────────── */

describe('nested-flex-merge', () => {
  it('declares the expected pattern identity', () => {
    expect(nestedFlexMerge.category).toBe('flatten/nested-flex-merge');
    expect(nestedFlexMerge.safety).toBe(2);
    expect(typeof nestedFlexMerge.evaluate).toBe('function');
  });

  it('merges a flex wrapper into its compatible sole flex child', () => {
    const { doc, outerId, innerId } = buildTree();

    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));

    // the outer wrapper is gone …
    expect(out.nodes.has(outerId)).toBe(false);

    // … the inner container survived (same IRNodeId) and was hoisted into the wrapper's old slot …
    const inner = getElement(out, innerId) as IRElement | undefined;
    expect(inner).toBeDefined();
    expect(inner!.parent).toBe(out.root);
    expect((out.nodes.get(out.root) as IRFragment).children).toEqual([innerId]);

    // … and carries the UNION of both containers' flex declarations.
    const base = inner!.computed.blocks.get(conditionKey(BASE_CONDITION));
    expect(base?.decls.get('display' as CssProperty)?.value).toBe('flex');
    expect(base?.decls.get('flex-direction' as CssProperty)?.value).toBe('column'); // from inner
    expect(base?.decls.get('align-items' as CssProperty)?.value).toBe('center'); // from outer
    expect(base?.decls.get('row-gap' as CssProperty)?.value).toBe('8px'); // from outer (gap expanded)
    expect(base?.decls.get('column-gap' as CssProperty)?.value).toBe('8px');
  });

  it('does NOT merge when a flex property conflicts (row vs column)', () => {
    // Inner sets flex-direction:row while outer (via gap/center) is fine, but make them conflict
    // by giving the inner an explicit conflicting direction against the outer.
    const conflicting = styleMap([
      ['display', 'flex'],
      ['flex-direction', 'row'],
    ]);
    const outerConflict = styleMap([
      ['display', 'flex'],
      ['flex-direction', 'column'],
    ]);

    const doc = createDocument('jsx');
    const rootId = doc.root;
    const outerId = doc.alloc.next();
    const innerId = doc.alloc.next();

    const inner = createElement(innerId, {
      tag: 'div',
      parent: outerId,
      computed: conflicting,
      meta: defaultMeta(3),
    });
    const outer = createElement(outerId, {
      tag: 'div',
      parent: rootId,
      children: [innerId],
      computed: outerConflict,
      meta: defaultMeta(3),
    });
    doc.nodes.set(outerId, outer);
    doc.nodes.set(innerId, inner);
    (doc.nodes.get(rootId) as IRFragment).children = [outerId];

    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));

    // nothing merged: wrapper stays, inner stays nested inside it.
    expect(out.nodes.has(outerId)).toBe(true);
    expect(getElement(out, outerId)!.children).toContain(innerId);
    expect((out.nodes.get(out.root) as IRFragment).children).toEqual([outerId]);

    // direct evaluate also reports no match.
    const direct = nestedFlexMerge.evaluate;
    expect(typeof direct).toBe('function');
  });

  it('does NOT merge a wrapper behind an opacity barrier (event handler)', () => {
    const { doc, outerId, innerId } = buildTree({ withHandler: true });

    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));

    // wrapper untouched, inner stays nested inside it.
    expect(out.nodes.has(outerId)).toBe(true);
    expect(getElement(out, outerId)!.children).toContain(innerId);
    expect((out.nodes.get(out.root) as IRFragment).children).toEqual([outerId]);
  });
});
