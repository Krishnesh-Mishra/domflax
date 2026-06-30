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

import { sizeShorthand } from './compress/size-shorthand';

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

const WIDTH = 'width' as CssProperty;
const HEIGHT = 'height' as CssProperty;
const SIZE = 'size' as CssProperty;

interface Tree {
  readonly doc: ReturnType<typeof createDocument>;
  readonly boxId: IRNodeId;
}

/**
 * Assemble: <root-fragment> → <box div (computed)>. `withHandler` flips the box's
 * `hasEventHandlers` opacity barrier for the negative case. `safetyFloor: 3` lets the safety-2
 * pattern's op clear the per-node floor.
 */
function buildTree(computed: StyleMap, withHandler = false): Tree {
  const doc = createDocument('jsx');
  const rootId = doc.root;
  const boxId = doc.alloc.next();

  const meta = defaultMeta(3);
  meta.hasEventHandlers = withHandler;
  const box = createElement(boxId, {
    tag: 'div',
    parent: rootId,
    computed,
    meta,
  });

  doc.nodes.set(boxId, box);
  (doc.nodes.get(rootId) as IRFragment).children = [boxId];

  return { doc, boxId };
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
  { phase: 'compress', category: 'compress/size-shorthand', patterns: [sizeShorthand] },
];

function baseDecls(doc: ReturnType<typeof createDocument>, id: IRNodeId) {
  return getElement(doc, id)!.computed.blocks.get(conditionKey(BASE_CONDITION))?.decls;
}

/* ───────────────────────── tests ───────────────────────── */

describe('size-shorthand', () => {
  it('declares the expected pattern identity', () => {
    expect(sizeShorthand.category).toBe('compress/size-shorthand');
    expect(sizeShorthand.safety).toBe(2);
  });

  it('collapses equal width and height into a single size declaration', () => {
    const { doc, boxId } = buildTree(
      styleMap([
        ['width', '1rem'],
        ['height', '1rem'],
      ]),
    );

    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));

    const decls = baseDecls(out, boxId);
    expect(decls).toBeDefined();
    // width/height are gone, replaced by the merged `size` longhand …
    expect(decls!.has(WIDTH)).toBe(false);
    expect(decls!.has(HEIGHT)).toBe(false);
    expect(decls!.get(SIZE)?.value).toBe('1rem');
  });

  it('does NOT collapse a box that has an event handler (opacity barrier)', () => {
    const { doc, boxId } = buildTree(
      styleMap([
        ['width', '1rem'],
        ['height', '1rem'],
      ]),
      true,
    );

    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));

    // the original longhands survive untouched; no `size` was introduced.
    const decls = baseDecls(out, boxId);
    expect(decls!.get(WIDTH)?.value).toBe('1rem');
    expect(decls!.get(HEIGHT)?.value).toBe('1rem');
    expect(decls!.has(SIZE)).toBe(false);
  });

  it('does NOT collapse when width and height differ (conflicting axes)', () => {
    const { doc, boxId } = buildTree(
      styleMap([
        ['width', '1rem'],
        ['height', '2rem'],
      ]),
    );

    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));

    const decls = baseDecls(out, boxId);
    expect(decls!.get(WIDTH)?.value).toBe('1rem');
    expect(decls!.get(HEIGHT)?.value).toBe('2rem');
    expect(decls!.has(SIZE)).toBe(false);
  });
});
