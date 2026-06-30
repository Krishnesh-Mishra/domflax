/**
 * @domflax/patterns — hand-built-IR test for the `redundant-inline-wrapper` flatten pattern.
 *
 * Mirrors `@domflax/pattern-kit`'s `pattern.test.ts`: builds a tiny IR document by hand (computed
 * styles populated via the shared normalizer), drives the pattern through `runPasses`, and asserts
 * the wrapper is removed on the positive case and preserved when an opacity barrier / own paint /
 * non-inline display makes it load-bearing.
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

import { redundantInlineWrapper } from './redundant-inline-wrapper.pattern';

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

interface BuildOpts {
  readonly wrapperStyle?: readonly (readonly [string, string])[];
  readonly withHandler?: boolean;
}

function buildTree(opts: BuildOpts = {}): {
  doc: IRDocument;
  wrapperId: IRNodeId;
  childId: IRNodeId;
} {
  const doc = createDocument('jsx');
  const rootId = doc.root;
  const wrapperId = doc.alloc.next();
  const childId = doc.alloc.next();

  const child = createElement(childId, {
    tag: 'a',
    parent: wrapperId,
    computed: styleMap([['background-color', 'blue']]),
    meta: defaultMeta(3),
  });

  const wrapperMeta = defaultMeta(3);
  wrapperMeta.hasEventHandlers = opts.withHandler ?? false;
  const wrapper = createElement(wrapperId, {
    tag: 'span',
    parent: rootId,
    children: [childId],
    computed: styleMap(opts.wrapperStyle ?? [['display', 'inline'], ['color', 'red']]),
    meta: wrapperMeta,
  });

  doc.nodes.set(wrapperId, wrapper);
  doc.nodes.set(childId, child);
  (doc.nodes.get(rootId) as IRFragment).children = [wrapperId];
  return { doc, wrapperId, childId };
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
  { phase: 'flatten', category: 'flatten/redundant-inline-wrapper', patterns: [redundantInlineWrapper] },
];

/* ───────────────────────── the suite ───────────────────────── */

describe('flatten/redundant-inline-wrapper', () => {
  it('removes an inline span wrapper and hoists its sole child, folding inherited color', () => {
    const { doc, wrapperId, childId } = buildTree();
    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));

    // Wrapper gone, child hoisted into the wrapper's slot.
    expect(out.nodes.has(wrapperId)).toBe(false);
    const child = getElement(out, childId);
    expect(child).toBeDefined();
    expect(child!.parent).toBe(out.root);
    expect((out.nodes.get(out.root) as IRFragment).children).toEqual([childId]);

    // The wrapper's inheritable `color` is folded onto the surviving child; its own paint survives.
    const base = child!.computed.blocks.get(conditionKey(BASE_CONDITION));
    expect(base?.decls.get('color' as CssProperty)?.value).toBe('red');
    expect(base?.decls.get('background-color' as CssProperty)?.value).toBe('blue');
  });

  it('keeps the wrapper when it carries an event handler (opacity barrier)', () => {
    const { doc, wrapperId, childId } = buildTree({ withHandler: true });
    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));

    expect(out.nodes.has(wrapperId)).toBe(true);
    expect(getElement(out, wrapperId)!.children).toContain(childId);
    expect((out.nodes.get(out.root) as IRFragment).children).toEqual([wrapperId]);
  });

  it('keeps the wrapper when it paints its own background (own visual style)', () => {
    const { doc, wrapperId } = buildTree({
      wrapperStyle: [['display', 'inline'], ['background-color', 'green']],
    });
    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));
    expect(out.nodes.has(wrapperId)).toBe(true);
  });

  it('keeps the wrapper when its display is not the inline default', () => {
    const { doc, wrapperId } = buildTree({ wrapperStyle: [['display', 'inline-block']] });
    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));
    expect(out.nodes.has(wrapperId)).toBe(true);
  });
});
