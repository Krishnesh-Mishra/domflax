import { describe, it, expect } from 'vitest';

import type {
  ApplyContext,
  ConditionKey,
  CssProperty,
  IRFragment,
  IRNodeId,
  Pass,
  StyleBlock,
  StyleCondition,
  StyleDecl,
  StyleMap,
  StyleOrigin,
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

import { dedupeClasses } from './compress/dedupe-classes';

/* ───────────────────────── hand-built IR fixtures (no resolver) ───────────────────────── */

const FONT_SIZE = 'font-size' as CssProperty;

/** A class-origin provenance record (the token that set/overrode a declaration). */
function classOrigin(tokenIndex: number, className: string): StyleOrigin {
  return { kind: 'class', tokenIndex, className };
}

/** Build one normalized longhand decl, attaching optional winning/overridden provenance. */
function mkDecl(
  prop: string,
  value: string,
  origin?: StyleOrigin,
  shadowed?: readonly StyleOrigin[],
): StyleDecl {
  const base = normalizer.normalizeDeclaration(prop, value, false)[0]!;
  const d: StyleDecl = { ...base };
  if (origin) (d as { origin?: StyleOrigin }).origin = origin;
  if (shadowed) (d as { shadowed?: readonly StyleOrigin[] }).shadowed = shadowed;
  return d;
}

/** Assemble a StyleMap from `[condition, decls]` pairs. */
function mkMap(blocks: readonly (readonly [StyleCondition, readonly StyleDecl[]])[]): StyleMap {
  const out = new Map<ConditionKey, StyleBlock>();
  for (const [condition, decls] of blocks) {
    const m = new Map<CssProperty, StyleDecl>();
    for (const d of decls) m.set(d.property, d);
    const block: StyleBlock = { condition, decls: m };
    out.set(conditionKey(condition), block);
  }
  return { blocks: out };
}

const MD: StyleCondition = { media: '(min-width: 768px)', states: [], pseudoElement: '' };

/** Normalized value of `font-size:1.125rem` — the surviving (winning) value in the positive case. */
const LG_VALUE = normalizer.normalizeDeclaration('font-size', '1.125rem', false)[0]!.value;

/**
 * POSITIVE fixture: `class="text-sm text-lg"` — both set `font-size`, `text-lg` (token 1) wins and
 * `text-sm` (token 0) is recorded as shadowed. `text-sm` never wins anything ⇒ fully overridden.
 */
function redundantStyle(): StyleMap {
  return mkMap([
    [
      BASE_CONDITION,
      [
        mkDecl('font-size', '1.125rem', classOrigin(1, 'text-lg'), [classOrigin(0, 'text-sm')]),
      ],
    ],
  ]);
}

/**
 * NEGATIVE fixture (conflicting condition): `text-sm` wins `font-size` at the BASE condition while
 * `md:text-lg` wins it only under a media query. Each token wins in its own condition, so NEITHER
 * is shadowed — dropping either would change the computed style at one breakpoint.
 */
function conditionalStyle(): StyleMap {
  return mkMap([
    [BASE_CONDITION, [mkDecl('font-size', '0.875rem', classOrigin(0, 'text-sm'))]],
    [MD, [mkDecl('font-size', '1.125rem', classOrigin(1, 'md:text-lg'))]],
  ]);
}

interface Tree {
  readonly doc: ReturnType<typeof createDocument>;
  readonly elId: IRNodeId;
}

/** <root-fragment> → <p (computed)>. `withHandler` flips the `hasEventHandlers` opacity barrier. */
function buildTree(computed: StyleMap, withHandler = false): Tree {
  const doc = createDocument('jsx');
  const elId = doc.alloc.next();

  const meta = defaultMeta(3);
  meta.hasEventHandlers = withHandler;
  const el = createElement(elId, { tag: 'p', parent: doc.root, computed, meta });

  doc.nodes.set(elId, el);
  (doc.nodes.get(doc.root) as IRFragment).children = [elId];

  return { doc, elId };
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
  { phase: 'compress', category: 'compress/dedupe-classes', patterns: [dedupeClasses] },
];

function baseFontSize(doc: ReturnType<typeof createDocument>, id: IRNodeId): StyleDecl | undefined {
  return getElement(doc, id)?.computed.blocks.get(conditionKey(BASE_CONDITION))?.decls.get(FONT_SIZE);
}

/* ───────────────────────── tests ───────────────────────── */

describe('dedupe-classes', () => {
  it('declares the compress/dedupe-classes contract', () => {
    expect(dedupeClasses.category).toBe('compress/dedupe-classes');
    expect(dedupeClasses.name).toBe('dedupe-classes');
    expect(dedupeClasses.safety).toBe(1);
  });

  it('drops a fully-overridden class token, leaving an identical computed style (positive)', () => {
    const { doc, elId } = buildTree(redundantStyle());

    // sanity: the input records `text-sm` as a shadowed (overridden) token.
    expect(baseFontSize(doc, elId)?.shadowed).toHaveLength(1);

    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));

    const after = baseFontSize(out, elId);
    expect(after).toBeDefined();
    // computed value is byte-for-byte identical (the winning token's value survives) …
    expect(after!.value).toBe(LG_VALUE);
    // … and the overridden token's provenance is gone ⇒ the redundant token was dropped.
    expect(after!.shadowed ?? []).toHaveLength(0);
    // the node was rewritten.
    expect(getElement(out, elId)!.meta.touched).toBe(true);
  });

  it('does NOT dedupe tokens that win in different conditions (conflicting-condition barrier)', () => {
    const { doc, elId } = buildTree(conditionalStyle());

    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));

    // both conditions survive untouched: each token still wins its own breakpoint.
    const el = getElement(out, elId)!;
    expect(el.meta.touched).toBe(false);
    expect(baseFontSize(out, elId)?.origin).toEqual(classOrigin(0, 'text-sm'));
    expect(el.computed.blocks.get(conditionKey(MD))?.decls.get(FONT_SIZE)?.origin).toEqual(
      classOrigin(1, 'md:text-lg'),
    );
  });

  it('does NOT dedupe a node behind an opacity barrier (event handler)', () => {
    const { doc, elId } = buildTree(redundantStyle(), true);

    const { doc: out } = runPasses(doc, PASSES, applyContext(doc));

    const el = getElement(out, elId)!;
    expect(el.meta.touched).toBe(false);
    // the redundant provenance is still present — nothing was rewritten.
    expect(baseFontSize(out, elId)?.shadowed).toHaveLength(1);
  });
});
