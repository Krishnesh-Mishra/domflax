/**
 * @domflax/pattern-kit/testing — the generic pattern test harness.
 *
 * Two suites, both frontend-agnostic:
 *
 *   • {@link runAutoTests} — drives every pattern's co-located {@link PatternTest} through an
 *     INJECTED, per-pattern `transform` (so pattern-kit never depends on a concrete frontend): each
 *     `case` must transform `before → after`; each `noMatch` must come back unchanged; the optional
 *     `custom` hook runs arbitrary assertions against the built transform.
 *
 *   • {@link runInvariants} — a pure IR-level suite needing only {@link @domflax/core} (no browser,
 *     no frontend): for each pattern it asserts purity (same input ⇒ same ops twice), that no op
 *     targets an opaque/dynamic node, that `unwrap` preserves the surviving child's IRNodeId, that
 *     the pattern never acts above its declared safety ceiling, and that re-running converges.
 *
 * Both call vitest's `describe`/`it`/`expect`, so a generated test file just invokes them at the top
 * level. Build the small IR fixtures with the core builders; styles use the shared normalizer.
 */

import { describe, it, expect } from 'vitest';

import type {
  ApplyContext,
  ConditionKey,
  CssProperty,
  DeepReadonly,
  IRDocument,
  IRElement,
  IRFragment,
  IRNode,
  IRNodeId,
  MatchContext,
  NodeLike,
  Pass,
  PassPhase,
  RewriteOp,
  RewriteOpDraft,
  SafetyLevel,
  SelectorIndex,
  StyleBlock,
  StyleDecl,
  StyleMap,
  StyleResolver,
} from '@domflax/core';
import {
  BASE_CONDITION,
  conditionKey,
  createDocument,
  createElement,
  createNullResolver,
  createNullSelectorIndex,
  createRewriteFactory,
  defaultMeta,
  elementIds,
  emptyStyleMap,
  getElement,
  runPasses,
  applyOps,
} from '@domflax/core';

import { normalizer } from './normalize';
import type { AuthoredPattern, TestHelpers } from './pattern';

/* ───────────────────────── auto-test harness ───────────────────────── */

/** Inject the frontend transform so pattern-kit stays frontend-agnostic. */
export type Transform = (code: string, filename: string) => string;

export interface AutoTestOptions {
  /**
   * Build the transform a given pattern's co-located tests run through. The harness is frontend-
   * agnostic, so the caller (which knows the providers/resolvers) supplies this: typically a Tailwind
   * transform by default and a custom-CSS one when `pattern.test.provider === 'custom'`.
   */
  readonly transformFor: (pattern: AuthoredPattern) => Transform;
  /** Filename passed to `transform`. Default `'X.tsx'`. */
  readonly filename?: string;
}

/** A pattern carrying an optional co-located test spec (what {@link runAutoTests} consumes). */
export type TestablePattern = AuthoredPattern;

/** Whitespace-insensitive comparison key. */
function ws(code: string): string {
  return code.replace(/\s+/g, ' ').trim();
}

/**
 * For each pattern, read its co-located `.test` and, through the per-pattern transform from
 * `transformFor`: run every `case` (assert `before → after`, whitespace-normalized), every `noMatch`
 * (assert the input is returned unchanged), and the optional `custom` hook.
 */
export function runAutoTests(
  patterns: readonly TestablePattern[],
  options: AutoTestOptions,
): void {
  const filename = options.filename ?? 'X.tsx';

  for (const p of patterns) {
    const test = p.test;
    const cases = test?.cases ?? [];
    const noMatch = test?.noMatch ?? [];

    describe(`${p.name} (cases)`, () => {
      const transform = options.transformFor(p);
      const helpers: TestHelpers = {
        transform: (code, file) => transform(code, file ?? filename),
        expectTransforms: (before, after) => {
          expect(ws(transform(before, filename))).toBe(ws(after));
        },
        expectUnchanged: (code) => {
          expect(ws(transform(code, filename))).toBe(ws(code));
        },
      };

      if (cases.length === 0 && noMatch.length === 0 && !test?.custom) {
        it('declares co-located tests', () => {
          // A pattern with no cases/noMatch/custom is still exercised by runInvariants; flag here so
          // an author who forgot to co-locate tests sees an explicit (failing) reminder.
          expect(test).toBeDefined();
        });
        return;
      }

      cases.forEach((c, i) => {
        it(c.name ?? `transforms case #${i + 1}`, () => {
          helpers.expectTransforms(c.before, c.after);
        });
      });

      noMatch.forEach((code, i) => {
        it(`leaves no-match case #${i + 1} unchanged`, () => {
          helpers.expectUnchanged(code);
        });
      });

      if (test?.custom) {
        it('custom assertions', () => {
          test.custom!(helpers);
        });
      }
    });
  }
}

/* ───────────────────────── IR fixtures (core builders) ───────────────────────── */

/** Build a single-(base-)condition StyleMap from `[property, value]` pairs via the normalizer. */
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

interface Fixture {
  readonly doc: IRDocument;
  readonly wrapperId: IRNodeId;
  readonly childId: IRNodeId;
}

/**
 * Canonical fixture: `<root> → <wrapper div (flex-center)> → <child div (own background)>`.
 * With `barriers`, every hard opacity barrier (incl. spread → opaque) is flipped on the wrapper so
 * a well-behaved pattern must decline. Every node gets `safetyFloor:3` so safety-≤3 ops clear it.
 */
function flexCenterFixture(opts?: { barriers?: boolean }): Fixture {
  const doc = createDocument('jsx');
  const rootId = doc.root;
  const wrapperId = doc.alloc.next();
  const childId = doc.alloc.next();

  const child = createElement(childId, {
    tag: 'div',
    parent: wrapperId,
    computed: styleMap([['background-color', 'red']]),
    meta: defaultMeta(3),
  });

  const wrapperMeta = defaultMeta(3);
  if (opts?.barriers) {
    wrapperMeta.hasRef = true;
    wrapperMeta.hasEventHandlers = true;
    wrapperMeta.hasDynamicChildren = true;
    wrapperMeta.hasDangerousHtml = true;
    wrapperMeta.hasSpreadAttrs = true; // → ctx.isOpaque(wrapper) is true
  }
  const wrapper = createElement(wrapperId, {
    tag: 'div',
    parent: rootId,
    children: [childId],
    computed: styleMap([
      ['display', 'flex'],
      ['align-items', 'center'],
      ['justify-content', 'center'],
    ]),
    meta: wrapperMeta,
  });

  doc.nodes.set(wrapperId, wrapper);
  doc.nodes.set(childId, child);
  (doc.nodes.get(rootId) as IRFragment).children = [wrapperId];

  return { doc, wrapperId, childId };
}

/* ───────────────────────── a faithful MatchContext (mirrors core) ───────────────────────── */

function ro<T>(v: T): DeepReadonly<T> {
  return v as DeepReadonly<T>;
}

function buildContext(
  doc: IRDocument,
  elementId: IRNodeId,
  deps: {
    resolver: StyleResolver;
    selectors: SelectorIndex;
    safety: SafetyLevel;
    phase: PassPhase;
    iteration: number;
  },
): MatchContext {
  const self = getElement(doc, elementId)!;

  const elementChildren = (): readonly DeepReadonly<IRElement>[] => {
    const out: DeepReadonly<IRElement>[] = [];
    for (const c of self.children) {
      const cn = doc.nodes.get(c);
      if (cn && cn.kind === 'element') out.push(ro(cn));
    }
    return out;
  };

  const ancestors = (): readonly DeepReadonly<IRElement>[] => {
    const out: DeepReadonly<IRElement>[] = [];
    let cur: IRNodeId | null = self.parent;
    while (cur != null) {
      const n: IRNode | undefined = doc.nodes.get(cur);
      if (!n) break;
      if (n.kind === 'element') out.push(ro(n));
      cur = n.parent;
    }
    return out;
  };

  const siblingAt = (delta: number): DeepReadonly<IRNode> | null => {
    if (self.parent == null) return null;
    const p = doc.nodes.get(self.parent);
    if (!p || (p.kind !== 'element' && p.kind !== 'fragment')) return null;
    const i = p.children.indexOf(elementId);
    const sib = p.children[i + delta];
    if (sib == null) return null;
    const sn = doc.nodes.get(sib);
    return sn ? ro(sn) : null;
  };

  const computedOf = (n: NodeLike): StyleMap => {
    const node = doc.nodes.get((n as IRNode).id);
    return node && node.kind === 'element' ? node.computed : emptyStyleMap();
  };

  return {
    node: ro(self),
    doc: ro(doc),
    resolver: deps.resolver,
    selectors: deps.selectors,
    safety: deps.safety,
    phase: deps.phase,
    iteration: deps.iteration,
    parent(): DeepReadonly<IRElement> | null {
      if (self.parent == null) return null;
      const p = doc.nodes.get(self.parent);
      return p && p.kind === 'element' ? ro(p) : null;
    },
    elementChildren,
    onlyElementChild(): DeepReadonly<IRElement> | null {
      const els = elementChildren();
      return els.length === 1 ? els[0]! : null;
    },
    computed(): StyleMap {
      return self.computed;
    },
    computedOf,
    isOpaque(n?): boolean {
      const target = n ? doc.nodes.get((n as IRElement).id) : self;
      if (!target || target.kind !== 'element') return true;
      return target.classes.opaque || target.meta.hasSpreadAttrs;
    },
    ancestors,
    closest(pred): DeepReadonly<IRElement> | null {
      for (const a of ancestors()) if (pred(a)) return a;
      return null;
    },
    prevSibling: () => siblingAt(-1),
    nextSibling: () => siblingAt(1),
    nthChildIndex(): number {
      if (self.parent == null) return 1;
      const p = doc.nodes.get(self.parent);
      if (!p || (p.kind !== 'element' && p.kind !== 'fragment')) return 1;
      let idx = 0;
      for (const c of p.children) {
        const cn = doc.nodes.get(c);
        if (cn && cn.kind === 'element') {
          idx += 1;
          if (c === elementId) return idx;
        }
      }
      return idx;
    },
  };
}

/* ───────────────────────── invariant helpers ───────────────────────── */

function phaseOf(p: AuthoredPattern): PassPhase {
  return p.category.split('/', 1)[0] as PassPhase;
}

/** Evaluate `p` against every live element; collect the union of emitted op drafts. */
function evalAll(doc: IRDocument, p: AuthoredPattern): RewriteOpDraft[] {
  const rw = createRewriteFactory();
  const resolver = createNullResolver();
  const selectors = createNullSelectorIndex();
  const phase = phaseOf(p);
  const out: RewriteOpDraft[] = [];
  for (const id of elementIds(doc)) {
    if (!getElement(doc, id)) continue;
    const ctx = buildContext(doc, id, { resolver, selectors, safety: 3, phase, iteration: 1 });
    const res = p.evaluate(ctx, rw);
    if (res) out.push(...res.ops);
  }
  return out;
}

function stamp(draft: RewriteOpDraft, p: AuthoredPattern): RewriteOp {
  return {
    ...draft,
    origin: { pattern: p.name, category: p.category, safety: p.safety },
  } as RewriteOp;
}

/** Every node id an op references. */
function opNodeIds(op: RewriteOpDraft): IRNodeId[] {
  switch (op.op) {
    case 'removeNode':
    case 'unwrap':
    case 'replaceWith':
    case 'wrap':
    case 'setClassList':
      return [op.target];
    case 'mergeStyle':
      return op.source == null ? [op.target] : [op.target, op.source];
    case 'moveNode':
      return [op.target, op.newParent];
    case 'insertBefore':
    case 'insertAfter':
      return [op.anchor];
    case 'mergeSiblings':
      return [op.first, op.second];
    case 'foldInheritedStyles':
      return [op.from, ...op.into];
  }
}

function isBarriered(n: IRNode): boolean {
  const m = n.meta;
  const hardBarrier =
    m.hasRef ||
    m.hasEventHandlers ||
    m.hasDynamicChildren ||
    m.hasDangerousHtml ||
    m.hasSpreadAttrs;
  if (hardBarrier) return true;
  return n.kind === 'element' && n.classes.opaque;
}

function applyContext(doc: IRDocument, ceiling: SafetyLevel): ApplyContext {
  return {
    doc,
    safetyCeiling: ceiling,
    normalizer,
    selectors: createNullSelectorIndex(),
    resolver: createNullResolver(),
  };
}

/**
 * Pure IR-level invariant suite. Needs only {@link @domflax/core} + the shared normalizer — no
 * frontend, no browser. Each pattern is exercised against canonical, builder-constructed fixtures.
 */
export function runInvariants(patterns: readonly AuthoredPattern[]): void {
  for (const p of patterns) {
    const phase = phaseOf(p);
    const pass: Pass = { phase, category: p.category, patterns: [p] };

    describe(`${p.name} (invariants)`, () => {
      it('declares a valid safety level', () => {
        expect([0, 1, 2, 3]).toContain(p.safety);
      });

      it('is pure: identical input ⇒ identical ops twice', () => {
        const first = evalAll(flexCenterFixture().doc, p);
        const second = evalAll(flexCenterFixture().doc, p);
        expect(first).toEqual(second);
      });

      it('emits no op targeting an opaque / dynamic node', () => {
        const { doc } = flexCenterFixture({ barriers: true });
        for (const op of evalAll(doc, p)) {
          for (const id of opNodeIds(op)) {
            const node = doc.nodes.get(id);
            if (node) expect(isBarriered(node)).toBe(false);
          }
        }
      });

      it('preserves the surviving child IRNodeId on unwrap', () => {
        const { doc } = flexCenterFixture();
        const ops = evalAll(doc, p).map((d) => stamp(d, p));
        if (ops.length === 0) return;
        const childrenByUnwrapTarget = new Map<IRNodeId, readonly IRNodeId[]>();
        for (const op of ops) {
          if (op.op === 'unwrap') {
            const target = doc.nodes.get(op.target);
            if (target && (target.kind === 'element' || target.kind === 'fragment')) {
              childrenByUnwrapTarget.set(op.target, [...target.children]);
            }
          }
        }
        if (childrenByUnwrapTarget.size === 0) return;
        const { doc: out } = applyOps(doc, ops, applyContext(doc, 3));
        for (const kids of childrenByUnwrapTarget.values()) {
          for (const cid of kids) expect(out.nodes.has(cid)).toBe(true);
        }
      });

      it('never acts above its declared safety ceiling', () => {
        if (p.safety === 0) return;
        const { doc } = flexCenterFixture();
        const below = (p.safety - 1) as SafetyLevel;
        const { results } = runPasses(doc, [pass], applyContext(doc, below));
        const touched = results.reduce((acc, r) => acc + r.touched.size, 0);
        expect(touched).toBe(0);
      });

      it('runs to a terminating fixpoint (no oscillation)', () => {
        const { doc } = flexCenterFixture();
        const { results } = runPasses(doc, [pass], applyContext(doc, 3));
        for (const r of results) expect(r.haltReason).not.toBe('oscillation');
      });
    });
  }
}
