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

import { normalizer } from './normalize';
import { pattern, type AuthoredPattern } from './pattern';
import { runAutoTests, runInvariants } from './testing';

/* ───────────────────────── fixtures ───────────────────────── */

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

const FLEX_CENTER = styleMap([
  ['display', 'flex'],
  ['align-items', 'center'],
  ['justify-content', 'center'],
]);
const CHILD_STYLE = styleMap([['background-color', 'red']]);

function buildTree(withHandler = false): {
  doc: ReturnType<typeof createDocument>;
  wrapperId: IRNodeId;
  childId: IRNodeId;
} {
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
  wrapperMeta.hasEventHandlers = withHandler;
  const wrapper = createElement(wrapperId, {
    tag: 'div',
    parent: rootId,
    children: [childId],
    computed: FLEX_CENTER,
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

/* ───────────────────────── flex-center, re-expressed via pattern() ───────────────────────── */

const flexCenter: AuthoredPattern = pattern({
  name: 'flex-center-wrapper',
  category: 'flatten/flex-center-wrapper',
  safety: 2,
  doc: {
    title: 'Flatten flex-centering wrapper',
    summary: 'A div that only centers a single child is removed; the child gains place-self:center.',
  },
  match: {
    tag: 'div',
    style: { display: 'flex', alignItems: 'center', justifyContent: 'center' },
    onlyChild: 'element',
    paintsNothing: true,
  },
  rewrite: { flattenInto: 'child', childGains: { placeSelf: 'center' } },
  examples: [
    {
      before: '<div style="display:flex;align-items:center;justify-content:center"><Child/></div>',
      after: '<Child style="place-self:center"/>',
    },
    { name: 'leaves a non-centering div alone', noMatch: '<Child/>' },
  ],
});

const PASSES: readonly Pass[] = [
  { phase: 'flatten', category: 'flatten/flex-center-wrapper', patterns: [flexCenter] },
];

describe('pattern() — declarative authoring sugar', () => {
  it('compiles to a valid Pattern with the declared identity', () => {
    expect(flexCenter.name).toBe('flex-center-wrapper');
    expect(flexCenter.category).toBe('flatten/flex-center-wrapper');
    expect(flexCenter.safety).toBe(2);
    expect(typeof flexCenter.evaluate).toBe('function');
    expect(flexCenter.examples).toHaveLength(2);
  });

  it('behaves equivalently to the verbose flex-center-wrapper: flattens onto the sole child', () => {
    const { doc, wrapperId, childId } = buildTree();
    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));

    expect(out.nodes.has(wrapperId)).toBe(false);

    const child = getElement(out, childId);
    expect(child).toBeDefined();
    expect(child!.parent).toBe(out.root);
    expect((out.nodes.get(out.root) as IRFragment).children).toContain(childId);

    const base = child!.computed.blocks.get(conditionKey(BASE_CONDITION));
    expect(base?.decls.get('place-self' as CssProperty)?.value).toBe('center');
    expect(base?.decls.get('background-color' as CssProperty)?.value).toBe('red');
  });

  it('auto-applies the opacity-barrier guard: does NOT flatten a wrapper with a handler', () => {
    const { doc, wrapperId, childId } = buildTree(true);
    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));

    expect(out.nodes.has(wrapperId)).toBe(true);
    expect(getElement(out, wrapperId)!.children).toContain(childId);
    expect((out.nodes.get(out.root) as IRFragment).children).toEqual([wrapperId]);
  });
});

/* ───────────────────────── harness smoke (exercises ./testing) ───────────────────────── */

// A trivial stand-in for a real frontend transform: collapses the known centering wrapper.
const stubTransform = (code: string): string =>
  code.includes('display:flex') ? '<Child style="place-self:center"/>' : code;

runAutoTests([flexCenter], { transform: stubTransform });
runInvariants([flexCenter]);
