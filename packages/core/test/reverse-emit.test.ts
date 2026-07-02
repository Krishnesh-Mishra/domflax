import { describe, it, expect } from 'vitest';

import { BASE_CONDITION, conditionKey, createDocument, createElement, defaultMeta } from '../src/ir/builders';
import { syncClassesFromComputed } from '../src/compress/reverse-emit';
import type {
  ClassList,
  ConditionKey,
  CssProperty,
  EmitContext,
  EmitResult,
  IRElement,
  ResolveInput,
  ResolveResult,
  SelectorUsage,
  StyleBlock,
  StyleDecl,
  StyleMap,
  StyleNormalizer,
  StyleResolver,
} from '../src/ir/types';

/* ───────────────────────── tiny test doubles ───────────────────────── */

/** A pass-through normalizer (we hand `syncClassesFromComputed` already-canonical maps). */
const idNormalizer = {
  version: 'test',
  normalizeDeclaration: () => [],
  normalizeValue: (_p: CssProperty, raw: string) => raw,
  normalizeStyleMap: (sm: StyleMap) => sm,
  equals: () => false,
  inherited: { isInherited: () => false },
} as unknown as StyleNormalizer;

function styleMap(decls: Array<[string, string]>): StyleMap {
  const map = new Map<CssProperty, StyleDecl>();
  for (const [property, value] of decls) {
    map.set(property as CssProperty, {
      property: property as CssProperty,
      value: value as StyleDecl['value'],
      important: false,
      relativeToParent: false,
      inherited: false,
    });
  }
  const block: StyleBlock = { condition: BASE_CONDITION, decls: map };
  return { blocks: new Map<ConditionKey, StyleBlock>([[conditionKey(BASE_CONDITION), block]]) };
}

function staticClasses(...tokens: string[]): ClassList {
  return {
    form: 'string-literal',
    segments: [{ kind: 'static', tokens: tokens.map((value) => ({ value })) }],
    valueSpan: null,
    hasDynamic: false,
    opaque: false,
    rewritable: true,
  };
}

/**
 * A resolver stub: `emit` returns the fixed minimal set; `selectorUsage` marks the listed tokens as
 * NON-droppable (e.g. a class a custom-CSS combinator selector depends on) and everything else as a
 * droppable plain subject.
 */
function stubResolver(emitClasses: string[], nonDroppable: ReadonlySet<string>): StyleResolver {
  return {
    id: 'stub',
    provider: 'stub',
    fingerprint: 'stub',
    owns: () => true,
    resolve: (_i: ResolveInput): ResolveResult => ({
      styles: styleMap([]),
      resolved: [],
      unknown: [],
      opaque: [],
      warnings: [],
    }),
    emit: (_s: StyleMap, _c: EmitContext): EmitResult => ({
      classes: emitClasses,
      exact: true,
      warnings: [],
    }),
    selectorUsage: (token: string): SelectorUsage => ({
      asSubject: true,
      asAncestor: nonDroppable.has(token),
      asCompound: false,
      asSibling: false,
      asHasArgument: false,
      asStructural: false,
      droppable: !nonDroppable.has(token),
    }),
  };
}

function elementWith(classes: ClassList, computed: StyleMap): { doc: ReturnType<typeof createDocument>; el: IRElement } {
  const doc = createDocument('jsx');
  const id = doc.alloc.next();
  const meta = defaultMeta(3);
  meta.touched = true;
  meta.styleDirty = true; // reverse-emit only re-derives classes for style-dirty elements
  const el = createElement(id, { tag: 'div', parent: doc.root, classes, computed, meta });
  doc.nodes.set(id, el);
  const root = doc.nodes.get(doc.root);
  if (root && root.kind === 'fragment') root.children = [id]; // make el reachable from root
  return { doc, el };
}

/* ───────────────────────── tests ───────────────────────── */

describe('syncClassesFromComputed — REPLACE with droppability gate', () => {
  it('replaces droppable utility tokens with the minimal emitted set', () => {
    // `px-4 py-4` collapsed to `padding` in computed; emit reproduces it as the single `p-4`.
    const { doc, el } = elementWith(
      staticClasses('px-4', 'py-4', 'bg-white'),
      styleMap([['padding', '1rem'], ['background-color', 'white']]),
    );
    syncClassesFromComputed(doc, stubResolver(['p-4', 'bg-white'], new Set()), idNormalizer);

    const tokens = el.classes.segments.flatMap((s) => (s.kind === 'static' ? s.tokens.map((t) => t.value) : []));
    expect(tokens).toContain('p-4');
    expect(tokens).toContain('bg-white');
    expect(tokens).not.toContain('px-4');
    expect(tokens).not.toContain('py-4');
  });

  it('NEVER drops a class a custom-CSS selector depends on (non-droppable), even if not re-emitted', () => {
    // `card` is referenced by a combinator selector (`.list > .card`) → non-droppable. Even though
    // emit does not list it, it must be preserved verbatim while the droppable `px-4`/`py-4` collapse.
    const { doc, el } = elementWith(
      staticClasses('card', 'px-4', 'py-4'),
      styleMap([['padding', '1rem']]),
    );
    syncClassesFromComputed(doc, stubResolver(['p-4'], new Set(['card'])), idNormalizer);

    const tokens = el.classes.segments.flatMap((s) => (s.kind === 'static' ? s.tokens.map((t) => t.value) : []));
    expect(tokens).toContain('card'); // selector-bound → preserved
    expect(tokens).toContain('p-4');
    expect(tokens).not.toContain('px-4');
    expect(tokens).not.toContain('py-4');
  });

  it('leaves classes untouched when emit yields nothing (resolver could not reverse anything)', () => {
    const { doc, el } = elementWith(staticClasses('px-4', 'py-4'), styleMap([['padding', '1rem']]));
    syncClassesFromComputed(doc, stubResolver([], new Set()), idNormalizer);

    const tokens = el.classes.segments.flatMap((s) => (s.kind === 'static' ? s.tokens.map((t) => t.value) : []));
    expect(tokens).toEqual(['px-4', 'py-4']);
  });

  it('leaves a STRUCTURAL BYSTANDER (touched but not styleDirty) byte-for-byte identical', () => {
    // A `.product-art` whose only "touch" was a neighbour's flatten: its computed never changed, so
    // even though emit WOULD synthesize `bg-cream-deep`, reverse-emit must not run on it at all.
    const { doc, el } = elementWith(staticClasses('product-art'), styleMap([['background', '#efe9dd']]));
    el.meta.styleDirty = false; // structural bystander — computed was NOT rewritten by any pass

    syncClassesFromComputed(doc, stubResolver(['bg-cream-deep'], new Set()), idNormalizer);

    const tokens = el.classes.segments.flatMap((s) => (s.kind === 'static' ? s.tokens.map((t) => t.value) : []));
    expect(tokens).toEqual(['product-art']); // unchanged — no redundant class added
  });

  it('never re-emits a class whose contribution a RETAINED class already covers', () => {
    // `.product-art` (non-droppable — selector-bound) already sets background:#efe9dd. Even on a
    // style-dirty element, the redundant `.bg-cream-deep` alternative must NOT be materialized, because
    // its declaration is already supplied by the retained class → the residual to emit is empty.
    const backgroundMap = styleMap([['background', '#efe9dd']]);
    const coveringResolver: StyleResolver = {
      id: 'stub',
      provider: 'stub',
      fingerprint: 'stub',
      owns: () => true,
      // `.product-art` resolves to exactly the element's background.
      resolve: (i: ResolveInput): ResolveResult => ({
        styles: i.classes.includes('product-art') ? backgroundMap : styleMap([]),
        resolved: [...i.classes],
        unknown: [],
        opaque: [],
        warnings: [],
      }),
      // If asked to reverse a NON-empty map, it would offer the redundant `bg-cream-deep`.
      emit: (s: StyleMap, _c: EmitContext): EmitResult => ({
        classes: s.blocks.size > 0 ? ['bg-cream-deep'] : [],
        exact: true,
        warnings: [],
      }),
      // `product-art` is selector-bound (non-droppable, retained); everything else is droppable.
      selectorUsage: (token: string): SelectorUsage => ({
        asSubject: true,
        asAncestor: token === 'product-art',
        asCompound: false,
        asSibling: false,
        asHasArgument: false,
        asStructural: false,
        droppable: token !== 'product-art',
      }),
    };

    const { doc, el } = elementWith(staticClasses('product-art'), backgroundMap);
    syncClassesFromComputed(doc, coveringResolver, idNormalizer);

    const tokens = el.classes.segments.flatMap((s) => (s.kind === 'static' ? s.tokens.map((t) => t.value) : []));
    expect(tokens).toEqual(['product-art']); // residual empty → nothing emitted, no inflation
  });
});
