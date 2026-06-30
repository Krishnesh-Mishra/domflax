/**
 * @domflax/core — T5 regression: a flatten must never DROP a style the resolver can't reproduce,
 * and a wrapper saved by that revert must NOT then be stripped by a *different* flatten pattern.
 *
 * These tests exercise the pass-manager's emittability revert + the "bar this node from further
 * flattening" rule in isolation, using two hand-built flatten patterns (a specialized one that
 * pushes a compensating `place-self:center` onto the child, and a generic passthrough that just
 * unwraps) plus a fake resolver whose `emit.exact` is toggled by the presence of `place-self`.
 */

import { describe, it, expect } from 'vitest';

import type {
  ApplyContext,
  CssProperty,
  CssValue,
  EmitResult,
  IRFragment,
  IRNodeId,
  MatchContext,
  Pattern,
  RewriteFactory,
  StyleBlock,
  StyleDecl,
  StyleMap,
  StyleNormalizer,
  StyleResolver,
} from '../src/types';
import {
  BASE_CONDITION,
  BASE_CONDITION_KEY,
  createDocument,
  createElement,
  createNullSelectorIndex,
  defaultMeta,
  emptyStyleMap,
  getElement,
  runPasses,
} from '../src/index';

/* ───────────────────────── helpers ───────────────────────── */

function styleMapOf(decls: readonly (readonly [string, string])[]): StyleMap {
  const map = new Map<CssProperty, StyleDecl>();
  for (const [prop, value] of decls) {
    map.set(prop as CssProperty, {
      property: prop as CssProperty,
      value: value as CssValue,
      important: false,
      relativeToParent: false,
      inherited: false,
    });
  }
  const block: StyleBlock = { condition: BASE_CONDITION, decls: map };
  return { blocks: new Map([[BASE_CONDITION_KEY, block]]) };
}

/** A resolver whose reverse-emit is EXACT unless `barredProp` appears in the target style. */
function fakeResolver(barredProp: string | null): StyleResolver {
  return {
    id: 'fake',
    provider: 'fake@0.0.0',
    fingerprint: 'fake',
    owns: () => false,
    resolve: () => ({
      styles: emptyStyleMap(),
      resolved: [],
      unknown: [],
      opaque: [],
      warnings: [],
    }),
    emit: (styles: StyleMap): EmitResult => {
      let hasBarred = false;
      if (barredProp) {
        for (const block of styles.blocks.values()) {
          if (block.decls.has(barredProp as CssProperty)) hasBarred = true;
        }
      }
      return { classes: [], exact: !hasBarred, warnings: [] };
    },
    selectorUsage: () => ({
      asSubject: false,
      asAncestor: false,
      asCompound: false,
      asSibling: false,
      asHasArgument: false,
      asStructural: false,
      droppable: true,
    }),
  };
}

/** `<root> → <wrapper div> → <child div (background)>`. */
function fixture(): { doc: ReturnType<typeof createDocument>; wrapperId: IRNodeId; childId: IRNodeId } {
  const doc = createDocument('jsx');
  const rootId = doc.root;
  const wrapperId = doc.alloc.next();
  const childId = doc.alloc.next();

  const child = createElement(childId, {
    tag: 'div',
    parent: wrapperId,
    computed: styleMapOf([['background-color', 'red']]),
    meta: defaultMeta(3),
  });
  const wrapper = createElement(wrapperId, {
    tag: 'div',
    parent: rootId,
    children: [childId],
    computed: styleMapOf([['display', 'flex']]),
    meta: defaultMeta(3),
  });

  doc.nodes.set(wrapperId, wrapper);
  doc.nodes.set(childId, child);
  (doc.nodes.get(rootId) as IRFragment).children = [wrapperId];
  return { doc, wrapperId, childId };
}

function ctxWith(doc: ReturnType<typeof createDocument>, resolver: StyleResolver): ApplyContext {
  return {
    doc,
    safetyCeiling: 3,
    normalizer: {} as unknown as StyleNormalizer, // only `.inherited` is read (by foldInheritedStyles, unused here)
    selectors: createNullSelectorIndex(),
    resolver,
  };
}

/* ───────────────────────── two flatten patterns ───────────────────────── */

/** Specialized: pushes `place-self:center` onto the sole child, then unwraps (mirrors flex-center). */
const centerWrapper: Pattern = {
  name: 'center-wrapper',
  category: 'flatten/center-wrapper',
  safety: 2,
  evaluate(ctx: MatchContext, rw: RewriteFactory) {
    const child = ctx.onlyElementChild();
    if (!child) return null;
    return {
      ops: [
        rw.mergeStyle(child, null, styleMapOf([['place-self', 'center']]), 'source-wins'),
        rw.unwrap(ctx.node),
      ],
    };
  },
};

/** Generic: unwraps the wrapper with NO compensating style (mirrors passthrough-wrapper). */
const passthrough: Pattern = {
  name: 'passthrough',
  category: 'flatten/passthrough',
  safety: 2,
  evaluate(ctx: MatchContext, rw: RewriteFactory) {
    const child = ctx.onlyElementChild();
    if (!child) return null;
    return { ops: [rw.unwrap(ctx.node)] };
  },
};

/* ───────────────────────── tests ───────────────────────── */

describe('T5 — emittability revert bars further flattening', () => {
  it('keeps the wrapper when the compensating style is not reproducible (and passthrough cannot strip it)', () => {
    const { doc, wrapperId, childId } = fixture();
    // center-wrapper is tried first; place-self is NOT emittable → it reverts AND bars the node, so
    // the later passthrough pattern must NOT flatten the wrapper either.
    const passes = [
      { phase: 'flatten' as const, category: 'flatten/all' as const, patterns: [centerWrapper, passthrough] },
    ];
    const { doc: out } = runPasses(doc, passes, ctxWith(doc, fakeResolver('place-self')));

    expect(out.nodes.has(wrapperId)).toBe(true); // wrapper preserved
    expect(getElement(out, wrapperId)!.children).toContain(childId);
  });

  it('control: passthrough alone DOES flatten (no specialized revert to bar it)', () => {
    const { doc, wrapperId, childId } = fixture();
    const passes = [
      { phase: 'flatten' as const, category: 'flatten/all' as const, patterns: [passthrough] },
    ];
    const { doc: out } = runPasses(doc, passes, ctxWith(doc, fakeResolver('place-self')));

    expect(out.nodes.has(wrapperId)).toBe(false); // wrapper removed
    expect((out.nodes.get(out.root) as IRFragment).children).toContain(childId);
  });

  it('control: when the compensating style IS reproducible, the wrapper flattens and the child gains it', () => {
    const { doc, wrapperId, childId } = fixture();
    const passes = [
      { phase: 'flatten' as const, category: 'flatten/all' as const, patterns: [centerWrapper, passthrough] },
    ];
    const { doc: out } = runPasses(doc, passes, ctxWith(doc, fakeResolver(null)));

    expect(out.nodes.has(wrapperId)).toBe(false); // wrapper removed
    const child = getElement(out, childId)!;
    expect(child.computed.blocks.get(BASE_CONDITION_KEY)?.decls.get('place-self' as CssProperty)?.value).toBe(
      'center',
    );
  });
});
