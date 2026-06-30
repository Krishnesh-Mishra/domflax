/**
 * @domflax/patterns — hand-built-IR test for the `inline-flex-center-wrapper` flatten pattern.
 *
 * Mirrors the flex-center hand-built-IR test: build an IR fixture whose wrapper carries the
 * inline-flex-centering computed signature (display:inline-flex; align-items:center;
 * justify-content:center) and a single element child, run it through the real `@domflax/core` pass
 * manager, and assert the wrapper is unwrapped while the surviving child gains `place-self:center`.
 * Two negative cases prove the guards hold: an event-handler wrapper (opacity barrier) and a wrapper
 * that paints its own background are both left untouched.
 */

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

import { inlineFlexCenterWrapper } from './inline-flex-center-wrapper.pattern';

/* ───────────────────────── fixtures ───────────────────────── */

/** Build a single-(base-)condition StyleMap from raw `[property, value]` pairs via the shared normalizer. */
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

const INLINE_FLEX_CENTER = styleMap([
  ['display', 'inline-flex'],
  ['align-items', 'center'],
  ['justify-content', 'center'],
]);
const CHILD_STYLE = styleMap([['background-color', 'red']]);

interface BuildOpts {
  readonly withHandler?: boolean;
  /** Give the wrapper its own background → it paints, so `paintsNothing` fails. */
  readonly wrapperPaints?: boolean;
}

function buildTree(opts: BuildOpts = {}): {
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
  wrapperMeta.hasEventHandlers = opts.withHandler ?? false;
  const wrapperStyle = opts.wrapperPaints
    ? styleMap([
        ['display', 'inline-flex'],
        ['align-items', 'center'],
        ['justify-content', 'center'],
        ['background-color', 'blue'],
      ])
    : INLINE_FLEX_CENTER;
  const wrapper = createElement(wrapperId, {
    tag: 'div',
    parent: rootId,
    children: [childId],
    computed: wrapperStyle,
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
  {
    phase: 'flatten',
    category: 'flatten/inline-flex-center-wrapper',
    patterns: [inlineFlexCenterWrapper],
  },
];

/* ───────────────────────── tests ───────────────────────── */

describe('inline-flex-center-wrapper (hand-built IR)', () => {
  it('flattens an inline-flex-centering wrapper onto its sole child, which gains place-self:center', () => {
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

  it('does NOT flatten a wrapper carrying an event handler (opacity barrier)', () => {
    const { doc, wrapperId, childId } = buildTree({ withHandler: true });
    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));

    expect(out.nodes.has(wrapperId)).toBe(true);
    expect(getElement(out, wrapperId)!.children).toContain(childId);
    expect((out.nodes.get(out.root) as IRFragment).children).toEqual([wrapperId]);
  });

  it('does NOT flatten a wrapper that paints its own background', () => {
    const { doc, wrapperId, childId } = buildTree({ wrapperPaints: true });
    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));

    expect(out.nodes.has(wrapperId)).toBe(true);
    expect(getElement(out, wrapperId)!.children).toContain(childId);
  });
});
