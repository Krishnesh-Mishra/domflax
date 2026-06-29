/**
 * @domflax/core — pass manager + supporting contexts.
 *
 * Runs {@link Pattern}s grouped by {@link PassCategory} in declared order, driving the `flatten`
 * phase to a fixpoint under a max-iteration budget, and isolating per-node pattern errors into
 * {@link Diagnostic}s (a thrown pattern never aborts the run — it becomes `DF_PATTERN_THREW`).
 *
 * Dependency-free: only the `./types` contract plus `./builders` + `./ops` runtime helpers.
 */

import type {
  ApplyContext,
  Captures,
  DeepReadonly,
  Diagnostic,
  ElementSpec,
  FixpointConfig,
  HaltReason,
  IRDocument,
  IRElement,
  IRNode,
  IRNodeId,
  MatchContext,
  NodeLike,
  NodeSpec,
  Pass,
  PassManager,
  PassPhase,
  Pattern,
  PhaseRunResult,
  ResolveInput,
  ResolveResult,
  RewriteFactory,
  RewriteOp,
  RewriteOpDraft,
  SelectorIndex,
  StyleConflictPolicy,
  StyleMap,
  StyleResolver,
  ElementLike,
  SelectorUsage,
  EmitContext,
  EmitResult,
} from './types';

import { childIds, elementIds, emptyStyleMap, getElement } from './builders';
import { applyOps } from './ops';

/* ───────────────────────── defaults ───────────────────────── */

export const DEFAULT_FIXPOINT: FixpointConfig = {
  maxIterations: 16,
  phases: { flatten: 16, compress: 8, extract: 4 },
  onBudgetExhausted: 'warn',
  detectOscillation: true,
};

const PHASE_ORDER: readonly PassPhase[] = ['flatten', 'compress', 'extract'];

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

function buildMatchContext(
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

/* ───────────────────────── the pass manager ───────────────────────── */

function stampOrigin(draft: RewriteOpDraft, pattern: Pattern): RewriteOp {
  return {
    ...draft,
    origin: { pattern: pattern.name, category: pattern.category, safety: pattern.safety },
  } as RewriteOp;
}

function patternsForPhase(passes: readonly Pass[], phase: PassPhase): Pattern[] {
  const out: Pattern[] = [];
  for (const pass of passes) {
    if (pass.phase !== phase) continue;
    for (const p of pass.patterns) out.push(p);
  }
  out.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return out;
}

interface RunState {
  doc: IRDocument;
}

/**
 * One sweep of a phase: evaluate every pattern against every live element, collect op drafts,
 * stamp origin, apply. Returns the number of ops successfully applied (0 ⇒ fixpoint for this
 * phase). Pattern throws are isolated into `DF_PATTERN_THREW` diagnostics.
 */
function runSweep(
  state: RunState,
  patterns: readonly Pattern[],
  ctx: ApplyContext,
  factory: RewriteFactory,
  phase: PassPhase,
  iteration: number,
  touched: Set<IRNodeId>,
  diagnostics: Diagnostic[],
): number {
  let appliedOps = 0;
  const resolver = ctx.resolver;
  const selectors = ctx.selectors;

  for (const elId of elementIds(state.doc)) {
    const el = getElement(state.doc, elId);
    if (!el) continue; // removed earlier in this sweep

    for (const pattern of patterns) {
      if (pattern.safety > ctx.safetyCeiling) continue;
      let drafts: readonly RewriteOpDraft[] = [];
      try {
        const mctx = buildMatchContext(
          state.doc,
          elId,
          resolver,
          selectors,
          ctx.safetyCeiling,
          phase,
          iteration,
        );
        const result = pattern.evaluate(mctx, factory);
        if (!result) continue;
        drafts = result.ops;
        if (result.diagnostics) for (const d of result.diagnostics) diagnostics.push(d);
      } catch (err) {
        diagnostics.push({
          code: 'DF_PATTERN_THREW',
          severity: 'error',
          message: `pattern '${pattern.name}' threw: ${String((err as Error)?.message ?? err)}`,
          nodeId: elId,
          pattern: pattern.name,
          phase,
          iteration,
          cause: err,
        });
        continue;
      }

      if (drafts.length === 0) continue;
      const ops = drafts.map((d) => stampOrigin(d, pattern));
      const outcome = applyOps(state.doc, ops, ctx);
      for (const d of outcome.result.diagnostics) diagnostics.push(d);
      if (outcome.result.appliedGroups > 0) {
        state.doc = outcome.doc;
        appliedOps += outcome.result.appliedGroups;
        for (const id of outcome.result.touched) touched.add(id);
        for (const id of outcome.result.created) touched.add(id);
        // tree changed → restart pattern evaluation for this element next iteration
        break;
      }
    }
  }
  return appliedOps;
}

/** Cheap structural fingerprint of the document for oscillation detection. */
function docFingerprint(doc: IRDocument): string {
  const parts: string[] = [];
  const visit = (id: IRNodeId): void => {
    const n = doc.nodes.get(id);
    if (!n) return;
    parts.push(`${id}:${n.kind}`);
    for (const c of childIds(n)) visit(c);
  };
  visit(doc.root);
  return parts.join('|');
}

/**
 * Runs `passes` over `doc` to a per-phase fixpoint. This is the concrete entry the pipeline calls
 * (the {@link PassManager} interface keeps passes on the call site; we accept them explicitly here
 * so the manager stays stateless).
 */
export function runPasses(
  doc: IRDocument,
  passes: readonly Pass[],
  ctx: ApplyContext,
  config?: FixpointConfig,
): { readonly doc: IRDocument; readonly results: readonly PhaseRunResult[] } {
  const cfg: FixpointConfig = { ...DEFAULT_FIXPOINT, ...config };
  const factory = createRewriteFactory();
  const state: RunState = { doc };
  const results: PhaseRunResult[] = [];

  for (const phase of PHASE_ORDER) {
    const patterns = patternsForPhase(passes, phase);
    const phaseTouched = new Set<IRNodeId>();
    const diagnostics: Diagnostic[] = [];
    const budget = cfg.phases[phase] ?? cfg.maxIterations;

    let iterations = 0;
    let converged = false;
    let haltReason: HaltReason = 'converged';
    const seen = new Set<string>();

    if (patterns.length === 0) {
      results.push({
        phase,
        iterations: 0,
        converged: true,
        haltReason: 'converged',
        touched: phaseTouched,
        diagnostics,
      });
      continue;
    }

    while (iterations < budget) {
      iterations += 1;
      const applied = runSweep(
        state,
        patterns,
        ctx,
        factory,
        phase,
        iterations,
        phaseTouched,
        diagnostics,
      );

      if (applied === 0) {
        converged = true;
        haltReason = 'converged';
        break;
      }

      if (cfg.detectOscillation) {
        const fp = docFingerprint(state.doc);
        if (seen.has(fp)) {
          haltReason = 'oscillation';
          diagnostics.push({
            code: 'DF_FIXPOINT_OSCILLATION',
            severity: 'warn',
            message: `phase '${phase}' oscillated; halting`,
            phase,
            iteration: iterations,
          });
          break;
        }
        seen.add(fp);
      }
    }

    if (!converged && haltReason !== 'oscillation') {
      haltReason = 'budget';
      diagnostics.push({
        code: 'DF_FIXPOINT_BUDGET',
        severity: cfg.onBudgetExhausted === 'error' ? 'error' : 'warn',
        message: `phase '${phase}' exhausted ${budget}-iteration budget`,
        phase,
        iteration: iterations,
      });
    }

    results.push({
      phase,
      iterations,
      converged,
      haltReason,
      touched: phaseTouched,
      diagnostics,
    });
  }

  return { doc: state.doc, results };
}

/** A {@link PassManager} that runs the given passes (carried on the manager instance). */
export function createPassManager(passes: readonly Pass[]): PassManager {
  return {
    run(doc: IRDocument, ctx: ApplyContext, config?: FixpointConfig): readonly PhaseRunResult[] {
      return runPasses(doc, passes, ctx, config).results;
    },
  };
}
