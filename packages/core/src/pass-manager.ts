/**
 * @domflax/core — pass manager (the sync, static flatten driver).
 *
 * Runs {@link Pattern}s grouped by {@link PassPhase} in declared order, driving the `flatten` phase to
 * a fixpoint under a max-iteration budget, isolating per-node pattern errors into {@link Diagnostic}s
 * (a thrown pattern never aborts the run — it becomes `DF_PATTERN_THREW`), and applying the static
 * flatten policy ({@link ApplyContext.gate}) — under `'provably-safe'` only provably layout-neutral
 * flattens commit, so the transform never changes rendering and never launches a browser.
 *
 * The supporting contexts (resolvers, selector index, rewrite factory, match context) live in
 * `./pass-context`; the static flatten classifier in `./flatten-safety`. Dependency-free: only the
 * `./types` contract + sibling runtime helpers.
 */

import type {
  ApplyContext,
  Diagnostic,
  FixpointConfig,
  HaltReason,
  IRDocument,
  IRNodeId,
  Pass,
  PassManager,
  PassPhase,
  Pattern,
  PhaseRunResult,
  RewriteFactory,
  RewriteOp,
  RewriteOpDraft,
  StyleMap,
  StyleNormalizer,
  StyleResolver,
  SyntheticSink,
  EmitContext,
} from './types';

import { childIds, elementIds, getElement } from './builders';
import { applyOps } from './ops';
import { buildMatchContext, createRewriteFactory } from './pass-context';
import { classifyFlattenOps } from './flatten-safety';

// Re-export the supporting contexts so `@domflax/core` consumers keep importing them from here / the
// barrel exactly as before this module was split.
export {
  buildMatchContext,
  buildSelectorIndex,
  createNullResolver,
  createNullSelectorIndex,
  createRewriteFactory,
} from './pass-context';

/* ───────────────────────── defaults ───────────────────────── */

export const DEFAULT_FIXPOINT: FixpointConfig = {
  maxIterations: 16,
  phases: { flatten: 16, compress: 8, extract: 4 },
  onBudgetExhausted: 'warn',
  detectOscillation: true,
};

export const PHASE_ORDER: readonly PassPhase[] = ['flatten', 'compress', 'extract'];

/* ───────────────────────── op stamping + phase grouping ───────────────────────── */

export function stampOrigin(draft: RewriteOpDraft, pattern: Pattern): RewriteOp {
  return {
    ...draft,
    origin: { pattern: pattern.name, category: pattern.category, safety: pattern.safety },
  } as RewriteOp;
}

export function patternsForPhase(passes: readonly Pass[], phase: PassPhase): Pattern[] {
  const out: Pattern[] = [];
  for (const pass of passes) {
    if (pass.phase !== phase) continue;
    for (const p of pass.patterns) out.push(p);
  }
  out.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return out;
}

export interface RunState {
  doc: IRDocument;
}

/* ───────────────────────── flatten residual-skip (never drop an unreproducible style) ───────────────────────── */

/** A throwaway {@link SyntheticSink} for the emit exactness probe (registrations are discarded). */
function probeSink(): SyntheticSink {
  return {
    register(s): string {
      return s.className;
    },
    drain(): readonly never[] {
      return [];
    },
  };
}

/** Nodes a group writes STYLE onto (the survivors a flatten transfers declarations to). */
function styleWriteTargets(ops: readonly RewriteOp[]): IRNodeId[] {
  const ids: IRNodeId[] = [];
  for (const op of ops) {
    if (op.op === 'mergeStyle' || op.op === 'setClassList') ids.push(op.target);
    else if (op.op === 'foldInheritedStyles') ids.push(...op.into);
  }
  return ids;
}

/** True iff the resolver can EXACTLY reverse-emit `sm` (no residual). An empty map is trivially exact. */
function emitIsExact(resolver: StyleResolver, normalizer: StyleNormalizer, sm: StyleMap): boolean {
  if (sm.blocks.size === 0) return true;
  try {
    const ctx: EmitContext = { normalizer, sink: probeSink() };
    const r = resolver.emit(sm, ctx);
    return r.exact && r.residual == null;
  } catch {
    return true; // a throwing resolver must never block a flatten
  }
}

/**
 * T5 — flatten must never DROP a style it can't reproduce. After a flatten transfers declarations onto
 * a surviving (rewritable) element, if the resolver can no longer EXACTLY reverse-emit that element's
 * computed style — and it could before — the flatten would silently lose the residual declarations
 * during reverse-emit, so the whole flatten is reverted (the wrapper is kept). Pre-existing residue
 * (already non-exact before the flatten) is not blamed on the flatten and does not trigger a revert.
 */
export function flattenWouldDropStyle(
  before: IRDocument,
  after: IRDocument,
  ops: readonly RewriteOp[],
  resolver: StyleResolver,
  normalizer: StyleNormalizer,
): boolean {
  for (const id of styleWriteTargets(ops)) {
    const newEl = getElement(after, id);
    if (!newEl) continue; // target was itself removed — its style lives on the survivor we also check
    // Opaque / dynamic class lists are kept verbatim by reverse-emit, so no style is dropped there.
    if (newEl.classes.opaque || newEl.classes.hasDynamic) continue;
    if (emitIsExact(resolver, normalizer, newEl.computed)) continue;
    const oldEl = getElement(before, id);
    const wasExact = !oldEl || emitIsExact(resolver, normalizer, oldEl.computed);
    if (wasExact) return true; // the flatten introduced an unreproducible style → revert
  }
  return false;
}

/* ───────────────────────── flatten gate decision (shared sync core) ───────────────────────── */

export type FlattenVerdict = 'commit' | 'revert';

/**
 * Decide what to do with a freshly-applied flatten op-group, given the gate. Returns:
 *   • `'commit'` — keep the outcome (the historical path for `'all'`, and provably-safe flattens).
 *   • `'revert'` — discard + bar the node (residual-drop, or a needs-verification flatten under the
 *                  `'provably-safe'` gate).
 *
 * `before`/`after` are the docs immediately around the group's application.
 */
export function flattenVerdict(
  before: IRDocument,
  after: IRDocument,
  ops: readonly RewriteOp[],
  ctx: ApplyContext,
): FlattenVerdict {
  // T5 (independent of the gate): a flatten must never drop a style the resolver can't re-emit.
  if (flattenWouldDropStyle(before, after, ops, ctx.resolver, ctx.normalizer)) return 'revert';

  const gate = ctx.gate ?? 'all';
  if (gate === 'all') return 'commit';

  const cls = classifyFlattenOps(before, after, ops, ctx.normalizer);
  return cls.kind === 'provably-safe' ? 'commit' : 'revert';
}

/* ───────────────────────── per-element pattern evaluation (shared) ───────────────────────── */

/**
 * Evaluate every pattern against `elId` until one produces ops; returns the stamped op list (and its
 * pattern), or null when no pattern matched. Pattern throws become `DF_PATTERN_THREW` diagnostics.
 */
export function evaluateElement(
  doc: IRDocument,
  elId: IRNodeId,
  patterns: readonly Pattern[],
  ctx: ApplyContext,
  factory: RewriteFactory,
  phase: PassPhase,
  iteration: number,
  diagnostics: Diagnostic[],
): { ops: RewriteOp[]; pattern: Pattern } | null {
  for (const pattern of patterns) {
    if (pattern.safety > ctx.safetyCeiling) continue;
    let drafts: readonly RewriteOpDraft[] = [];
    try {
      const mctx = buildMatchContext(doc, elId, ctx.resolver, ctx.selectors, ctx.safetyCeiling, phase, iteration);
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
    return { ops: drafts.map((d) => stampOrigin(d, pattern)), pattern };
  }
  return null;
}

/** Emit the diagnostic recorded when a flatten is reverted by the gate / residual guard. */
export function revertDiagnostic(
  pattern: Pattern,
  elId: IRNodeId,
  phase: PassPhase,
  iteration: number,
  resolverId: string,
): Diagnostic {
  return {
    code: 'DF_VERIFY_REVERTED',
    severity: 'warn',
    message:
      `flatten '${pattern.name}' reverted on node ${elId}: it would change rendering (drops a style, ` +
      `establishes layout context, or assumes a parent context) and was not proven safe by resolver ` +
      `'${resolverId}'`,
    nodeId: elId,
    pattern: pattern.name,
    phase,
    iteration,
  };
}

/* ───────────────────────── one sweep (sync) ───────────────────────── */

/**
 * One sweep of a phase: evaluate every pattern against every live element, collect op drafts, stamp
 * origin, apply, then commit/revert per {@link flattenVerdict}. Returns the number of ops applied
 * (0 ⇒ fixpoint for this phase). Under the `'provably-safe'` gate, any flatten that is not provably
 * safe is reverted — the transform is fully static and never changes rendering.
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
  flattenBarred: Set<IRNodeId>,
): number {
  let appliedOps = 0;

  for (const elId of elementIds(state.doc)) {
    const el = getElement(state.doc, elId);
    if (!el) continue; // removed earlier in this sweep
    if (phase === 'flatten' && flattenBarred.has(elId)) continue;

    const evaluated = evaluateElement(state.doc, elId, patterns, ctx, factory, phase, iteration, diagnostics);
    if (!evaluated) continue;
    const { ops, pattern } = evaluated;

    const outcome = applyOps(state.doc, ops, ctx);
    for (const d of outcome.result.diagnostics) diagnostics.push(d);
    if (outcome.result.appliedGroups === 0) continue;

    if (phase === 'flatten') {
      const verdict = flattenVerdict(state.doc, outcome.doc, ops, ctx);
      if (verdict !== 'commit') {
        // Discard the outcome (keep the wrapper) AND bar this node from any further flatten this run.
        diagnostics.push(revertDiagnostic(pattern, elId, phase, iteration, ctx.resolver.id));
        flattenBarred.add(elId);
        continue;
      }
    }

    state.doc = outcome.doc;
    appliedOps += outcome.result.appliedGroups;
    for (const id of outcome.result.touched) touched.add(id);
    for (const id of outcome.result.created) touched.add(id);
  }
  return appliedOps;
}

/* ───────────────────────── oscillation fingerprint ───────────────────────── */

/** Cheap structural fingerprint of the document for oscillation detection. */
export function docFingerprint(doc: IRDocument): string {
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

/* ───────────────────────── the fixpoint driver (sync) ───────────────────────── */

/** A single phase's terminal result, built from the loop's accounting. */
export interface PhaseLoopState {
  iterations: number;
  converged: boolean;
  haltReason: HaltReason;
  readonly touched: Set<IRNodeId>;
  readonly diagnostics: Diagnostic[];
  readonly seen: Set<string>;
}

/** Record the budget-exhausted diagnostic + finalize a phase result. Shared by sync + async drivers. */
export function finalizePhase(
  phase: PassPhase,
  s: PhaseLoopState,
  budget: number,
  onBudgetExhausted: 'warn' | 'error',
): PhaseRunResult {
  if (!s.converged && s.haltReason !== 'oscillation') {
    s.haltReason = 'budget';
    s.diagnostics.push({
      code: 'DF_FIXPOINT_BUDGET',
      severity: onBudgetExhausted === 'error' ? 'error' : 'warn',
      message: `phase '${phase}' exhausted ${budget}-iteration budget`,
      phase,
      iteration: s.iterations,
    });
  }
  return {
    phase,
    iterations: s.iterations,
    converged: s.converged,
    haltReason: s.haltReason,
    touched: s.touched,
    diagnostics: s.diagnostics,
  };
}

/**
 * Runs `passes` over `doc` to a per-phase fixpoint (synchronous). This is the concrete entry the
 * pipeline calls. Under the `'provably-safe'` gate, flattens that are not provably layout-neutral are
 * reverted — the transform is fully static and never changes rendering.
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
  // Nodes barred from flattening after a revert — persists across sweeps/phases.
  const flattenBarred = new Set<IRNodeId>();

  for (const phase of PHASE_ORDER) {
    const patterns = patternsForPhase(passes, phase);
    const budget = cfg.phases[phase] ?? cfg.maxIterations;
    const s: PhaseLoopState = {
      iterations: 0,
      converged: false,
      haltReason: 'converged',
      touched: new Set(),
      diagnostics: [],
      seen: new Set(),
    };

    if (patterns.length === 0) {
      s.converged = true;
      results.push(finalizePhase(phase, s, budget, cfg.onBudgetExhausted));
      continue;
    }

    while (s.iterations < budget) {
      s.iterations += 1;
      const applied = runSweep(
        state,
        patterns,
        ctx,
        factory,
        phase,
        s.iterations,
        s.touched,
        s.diagnostics,
        flattenBarred,
      );

      if (applied === 0) {
        s.converged = true;
        break;
      }

      if (cfg.detectOscillation) {
        const fp = docFingerprint(state.doc);
        if (s.seen.has(fp)) {
          s.haltReason = 'oscillation';
          s.diagnostics.push({
            code: 'DF_FIXPOINT_OSCILLATION',
            severity: 'warn',
            message: `phase '${phase}' oscillated; halting`,
            phase,
            iteration: s.iterations,
          });
          break;
        }
        s.seen.add(fp);
      }
    }

    results.push(finalizePhase(phase, s, budget, cfg.onBudgetExhausted));
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
