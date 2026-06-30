/**
 * @domflax/core — pass-manager supporting contexts (resolvers, selector index, rewrite factory,
 * match context).
 *
 * Split out of `pass-manager.ts` so the sync engine, the async verifier-gated engine, and the
 * classification module can all share the same context construction without any of those files
 * exceeding the module-size budget. Dependency-free: only the `./types` contract + `./builders`.
 */

import type {
  DeepReadonly,
  ElementLike,
  ElementSpec,
  EmitContext,
  EmitResult,
  IRDocument,
  IRElement,
  IRNode,
  IRNodeId,
  MatchContext,
  NodeLike,
  NodeSpec,
  PassPhase,
  ResolveInput,
  ResolveResult,
  RewriteFactory,
  RewriteOpDraft,
  SelectorIndex,
  SelectorUsage,
  StyleConflictPolicy,
  StyleMap,
  StyleResolver,
} from './types';

import { elementIds, emptyStyleMap, getElement } from './builders';

/* ───────────────────────── default resolvers / selector index ───────────────────────── */

/** A no-op resolver: owns nothing, resolves to empty styles. Useful as an injection default. */
export function createNullResolver(): StyleResolver {
  const empty: ResolveResult = {
    styles: emptyStyleMap(),
    resolved: [],
    unknown: [],
    opaque: [],
    warnings: [],
  };
  const usage: SelectorUsage = {
    asSubject: false,
    asAncestor: false,
    asCompound: false,
    asSibling: false,
    asHasArgument: false,
    asStructural: false,
    droppable: true,
  };
  return {
    id: 'null',
    provider: 'null@0.0.0',
    fingerprint: 'null',
    owns(): boolean {
      return false;
    },
    resolve(_input: ResolveInput): ResolveResult {
      return empty;
    },
    emit(_styles: StyleMap, _ctx: EmitContext): EmitResult {
      return { classes: [], exact: true, warnings: [] };
    },
    selectorUsage(): SelectorUsage {
      return usage;
    },
  };
}

/** A SelectorIndex that reports zero CSS-targeting (no combinator/structural coupling). */
export function createNullSelectorIndex(): SelectorIndex {
  const none: ReadonlySet<IRNodeId> = new Set();
  return {
    targetedByCombinator(): boolean {
      return false;
    },
    targetedByStructuralPseudo(): boolean {
      return false;
    },
    reparentImpact(): ReadonlySet<IRNodeId> {
      return none;
    },
  };
}

/** Resolvers that can enumerate the project's COMPLEX selectors (the custom-CSS resolver) expose this. */
interface ComplexSelectorCapable {
  complexSelectors(): readonly string[];
}

function hasComplexSelectors(r: StyleResolver): r is StyleResolver & ComplexSelectorCapable {
  return typeof (r as Partial<ComplexSelectorCapable>).complexSelectors === 'function';
}

/**
 * Build a real {@link SelectorIndex} from the active resolver.
 *
 * For a resolver that reports project COMPLEX selectors — anything with a combinator (`>`/`+`/`~`/
 * descendant) or a structural pseudo, i.e. the custom-CSS resolver — every element whose static class
 * participates in such a selector is flagged so the flatten/compress guards (`targetedByCombinator` /
 * `affectsSelectorMatching`) fire and a wrapper a selector depends on is NOT flattened. An element is
 * combinator-coupled when one of its classes is used as a descendant/child ancestor, as a sibling
 * subject, or as a `:has()` argument; structural-coupled when used in `:nth-child(...)` etc.
 *
 * For a combinator-free resolver (Tailwind utilities — no `complexSelectors()`), this degrades to the
 * null index so behaviour is unchanged.
 */
export function buildSelectorIndex(doc: IRDocument, resolver: StyleResolver): SelectorIndex {
  if (!hasComplexSelectors(resolver) || resolver.complexSelectors().length === 0) {
    return createNullSelectorIndex();
  }

  const combinator = new Set<IRNodeId>();
  const structural = new Set<IRNodeId>();

  for (const id of elementIds(doc)) {
    const el = getElement(doc, id);
    if (!el) continue;
    for (const seg of el.classes.segments) {
      if (seg.kind !== 'static') continue;
      for (const t of seg.tokens) {
        const u = resolver.selectorUsage(t.value);
        // Combinator coupling: descendant/child ancestor, sibling subject, or `:has()` argument —
        // reparenting/removing the element would change a combinator match-set.
        if (u.asAncestor || u.asSibling || u.asHasArgument) combinator.add(id);
        if (u.asStructural) structural.add(id);
      }
    }
  }

  // reparentImpact(id): non-empty when removing/unwrapping `id` would change a combinator/structural
  // match-set — `id` itself is coupled (its own match), or it is the matched ancestor of a child
  // (removing it reparents that child out of the relation). Self + element children is conservative
  // and sufficient for the flatten guard.
  const impact = new Map<IRNodeId, Set<IRNodeId>>();
  for (const id of elementIds(doc)) {
    const el = getElement(doc, id);
    if (!el) continue;
    if (!combinator.has(id) && !structural.has(id)) continue;
    const set = new Set<IRNodeId>([id]);
    for (const c of el.children) {
      const cn = doc.nodes.get(c);
      if (cn && cn.kind === 'element') set.add(c);
    }
    impact.set(id, set);
  }

  const empty: ReadonlySet<IRNodeId> = new Set();
  return {
    targetedByCombinator: (id: IRNodeId): boolean => combinator.has(id),
    targetedByStructuralPseudo: (id: IRNodeId): boolean => structural.has(id),
    reparentImpact: (id: IRNodeId): ReadonlySet<IRNodeId> => impact.get(id) ?? empty,
  };
}

/* ───────────────────────── rewrite factory (emits origin-free drafts) ───────────────────────── */

/** Every {@link NodeLike}/{@link ElementLike} carries a readonly `id`. */
function idOf(n: ElementLike | NodeLike): IRNodeId {
  return (n as IRElement).id;
}

/** The pattern-kit factory: produces op DRAFTS and detached NodeSpecs without any allocation. */
export function createRewriteFactory(): RewriteFactory {
  return {
    unwrap(target: ElementLike): RewriteOpDraft {
      return { op: 'unwrap', target: idOf(target) };
    },
    removeNode(target: NodeLike): RewriteOpDraft {
      return { op: 'removeNode', target: idOf(target) };
    },
    replaceWith(target: NodeLike, replacement: NodeSpec): RewriteOpDraft {
      return { op: 'replaceWith', target: idOf(target), replacement };
    },
    wrap(target: NodeLike, wrapper: ElementSpec): RewriteOpDraft {
      return { op: 'wrap', target: idOf(target), wrapper };
    },
    insertBefore(anchor: NodeLike, node: NodeSpec): RewriteOpDraft {
      return { op: 'insertBefore', anchor: idOf(anchor), node };
    },
    insertAfter(anchor: NodeLike, node: NodeSpec): RewriteOpDraft {
      return { op: 'insertAfter', anchor: idOf(anchor), node };
    },
    moveNode(target: NodeLike, newParent: ElementLike, index: number): RewriteOpDraft {
      return { op: 'moveNode', target: idOf(target), newParent: idOf(newParent), index };
    },
    mergeSiblings(first: NodeLike, second: NodeLike): RewriteOpDraft {
      return { op: 'mergeSiblings', first: idOf(first), second: idOf(second) };
    },
    setClassList(target: ElementLike, style: StyleMap, preserveOpaque = true): RewriteOpDraft {
      return { op: 'setClassList', target: idOf(target), style, preserveOpaque };
    },
    mergeStyle(
      target: ElementLike,
      source: ElementLike | null,
      style: StyleMap,
      onConflict: StyleConflictPolicy = 'abort',
    ): RewriteOpDraft {
      return {
        op: 'mergeStyle',
        target: idOf(target),
        source: source ? idOf(source) : null,
        style,
        onConflict,
      };
    },
    foldInheritedStyles(
      from: ElementLike,
      into: ElementLike | readonly ElementLike[],
      opts?: { only?: readonly import('./types').CssProperty[]; conditions?: 'base' | 'all' },
    ): RewriteOpDraft {
      const list: readonly ElementLike[] = Array.isArray(into)
        ? (into as readonly ElementLike[])
        : [into as ElementLike];
      return {
        op: 'foldInheritedStyles',
        from: idOf(from),
        into: list.map((t) => idOf(t)),
        properties: opts?.only ?? 'all-inherited',
        conditions: opts?.conditions ?? 'base',
      };
    },
    element(spec: ElementSpec): NodeSpec {
      return spec;
    },
    text(value: string): NodeSpec {
      return { kind: 'text', value };
    },
    keep(node: NodeLike): NodeSpec {
      return { kind: 'ref', ref: idOf(node) };
    },
  };
}

/* ───────────────────────── match context ───────────────────────── */

function ro<T>(v: T): DeepReadonly<T> {
  return v as DeepReadonly<T>;
}

/** Build the read-only {@link MatchContext} a pattern's `evaluate` receives for one element. */
export function buildMatchContext(
  doc: IRDocument,
  elementId: IRNodeId,
  resolver: StyleResolver,
  selectors: SelectorIndex,
  safety: import('./types').SafetyLevel,
  phase: PassPhase,
  iteration: number,
): MatchContext {
  const self = getElement(doc, elementId)!;

  const parentEl = (): DeepReadonly<IRElement> | null => {
    if (self.parent == null) return null;
    const p = doc.nodes.get(self.parent);
    return p && p.kind === 'element' ? ro(p) : null;
  };

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
    resolver,
    selectors,
    safety,
    phase,
    iteration,
    parent: parentEl,
    elementChildren,
    onlyElementChild(): DeepReadonly<IRElement> | null {
      const els = elementChildren();
      return els.length === 1 ? els[0]! : null;
    },
    computed(): StyleMap {
      return self.computed;
    },
    computedOf,
    isOpaque(n?: ElementLike): boolean {
      const target = n ? doc.nodes.get((n as IRElement).id) : self;
      if (!target || target.kind !== 'element') return true;
      return target.classes.opaque || target.meta.hasSpreadAttrs;
    },
    ancestors,
    closest(pred): DeepReadonly<IRElement> | null {
      for (const a of ancestors()) if (pred(a)) return a;
      return null;
    },
    prevSibling(): DeepReadonly<IRNode> | null {
      return siblingAt(-1);
    },
    nextSibling(): DeepReadonly<IRNode> | null {
      return siblingAt(1);
    },
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
