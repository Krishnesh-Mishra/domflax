/**
 * @domflax/core — the pure, single-file pipeline.
 *
 * Wires injected interfaces together: {@link Frontend} → resolve → {@link PassManager} →
 * {@link Backend}. Core itself stays dependency-free; the resolver, frontend, and backend are all
 * supplied by the caller, so no heavy third-party libs ever reach this package.
 */

import type {
  ApplyContext,
  Backend,
  BackendContext,
  CodegenResult,
  Diagnostic,
  EditPlan,
  Frontend,
  FrontendParseContext,
  IRDocument,
  IRElement,
  PassPhase,
  Pipeline,
  PipelineInput,
  PipelineOutput,
  PipelineStats,
  SourceSpan,
  StyleMap,
  SyntheticClass,
  SyntheticSink,
} from './types';

import { elementIds, getElement } from './builders';
import { createNullSelectorIndex, runPasses } from './pass-manager';

/* ───────────────────────── synthetic sink ───────────────────────── */

/** A minimal in-memory {@link SyntheticSink}: dedupes by className, drains in insertion order. */
export function createSyntheticSink(): SyntheticSink {
  const map = new Map<string, SyntheticClass>();
  return {
    register(s: SyntheticClass): string {
      if (!map.has(s.className)) map.set(s.className, s);
      return s.className;
    },
    drain(): readonly SyntheticClass[] {
      return [...map.values()];
    },
  };
}

/* ───────────────────────── resolve step ───────────────────────── */

function staticClassTokens(el: IRElement): string[] {
  const out: string[] = [];
  for (const seg of el.classes.segments) {
    if (seg.kind === 'static') for (const t of seg.tokens) out.push(t.value);
  }
  return out;
}

/**
 * Populate each element's `computed` StyleMap from its author classes via the injected resolver.
 * Opaque/spread elements and elements without static classes are left untouched. Resolver throws
 * are isolated into diagnostics (a stub resolver may legitimately be NotImplemented).
 */
function resolveStyles(
  doc: IRDocument,
  input: PipelineInput,
  diagnostics: Diagnostic[],
): void {
  const { resolver, normalizer } = input;
  for (const id of elementIds(doc)) {
    const el = getElement(doc, id);
    if (!el || el.classes.opaque) continue;
    const tokens = staticClassTokens(el);
    if (tokens.length === 0) continue;
    try {
      const result = resolver.resolve({
        classes: tokens,
        element: {
          tagName: el.tag,
          namespace: el.namespace === 'svg' ? 'svg' : 'html',
        },
      });
      let styles: StyleMap = result.styles;
      try {
        styles = normalizer.normalizeStyleMap(styles);
      } catch {
        /* normalizer is optional/stubbed — keep raw styles */
      }
      el.computed = styles;
      for (const w of result.warnings) {
        diagnostics.push({
          code: 'DF_STYLE_CONFLICT_UNRESOLVED',
          severity: w.severity,
          message: w.message,
          nodeId: id,
        });
      }
    } catch (err) {
      diagnostics.push({
        code: 'DF_OP_PRECONDITION_FAILED',
        severity: 'debug',
        message: `resolve skipped for <${el.tag}>: ${String((err as Error)?.message ?? err)}`,
        nodeId: id,
        cause: err,
      });
    }
  }
}

/* ───────────────────────── the pipeline ───────────────────────── */

const ZERO_ITERATIONS: Readonly<Record<PassPhase, number>> = {
  flatten: 0,
  compress: 0,
  extract: 0,
};

class DefaultPipeline implements Pipeline {
  run(input: PipelineInput): PipelineOutput {
    const startedAt = now();
    const diagnostics: Diagnostic[] = [];
    const report = (d: Diagnostic): void => {
      diagnostics.push(d);
      input.reporter?.report(d);
    };

    // 1. PARSE ────────────────────────────────────────────────────────────
    const parseCtx: FrontendParseContext = {
      id: input.id,
      kind: input.kind,
      resolver: input.resolver,
      normalizer: input.normalizer,
      config: { preserveComments: input.config?.preserveComments ?? true },
      onDiagnostic: report,
    };
    if (input.babelAst !== undefined) parseCtx.babelAst = input.babelAst;

    const parsed = input.frontend.parse(input.code, parseCtx);
    for (const d of parsed.diagnostics) report(d);
    const doc = parsed.doc;
    const nodesIn = doc.nodes.size;

    // 2. RESOLVE ──────────────────────────────────────────────────────────
    resolveStyles(doc, input, diagnostics);

    // 3. PASSES (fixpoint per phase) ──────────────────────────────────────
    const ctx: ApplyContext = {
      doc,
      safetyCeiling: input.config?.safety ?? 2,
      normalizer: input.normalizer,
      selectors: createNullSelectorIndex(),
      resolver: input.resolver,
    };
    const { doc: optimized, results } = runPasses(doc, input.passes, ctx, fixpointFrom(input));

    let opsApplied = 0;
    const iterations: Record<PassPhase, number> = { ...ZERO_ITERATIONS };
    for (const r of results) {
      iterations[r.phase] = r.iterations;
      for (const d of r.diagnostics) {
        diagnostics.push(d);
        input.reporter?.report(d);
      }
      opsApplied += r.touched.size;
    }

    // 4. PRINT ────────────────────────────────────────────────────────────
    const editPlan: EditPlan = {
      moduleId: input.id,
      ops: [],
      provenance: new Map(),
    };
    const backendCtx: BackendContext = {
      normalizer: input.normalizer,
      resolver: input.resolver,
      sink: createSyntheticSink(),
      eol: eolOf(optimized),
      onDiagnostic: report,
    };
    const printed: CodegenResult = input.backend.print(optimized, editPlan, backendCtx);
    for (const d of printed.diagnostics) {
      diagnostics.push(d);
      input.reporter?.report(d);
    }

    // 5. ASSEMBLE OUTPUT ──────────────────────────────────────────────────
    const stats: PipelineStats = {
      nodesIn,
      nodesOut: optimized.nodes.size,
      opsApplied,
      iterations,
      durationMs: now() - startedAt,
    };
    const touched: readonly SourceSpan[] = printed.edits.map((e) => e.span);

    return {
      code: printed.code,
      map: printed.map,
      changed: printed.code !== input.code,
      touched,
      diagnostics,
      stats,
      doc: optimized,
      editPlan,
    };
  }
}

function fixpointFrom(input: PipelineInput): import('./types').FixpointConfig | undefined {
  const fp = input.config?.fixpoint;
  if (!fp) return undefined;
  return {
    maxIterations: fp.maxIterations ?? 16,
    phases: fp.phases ?? {},
    onBudgetExhausted: fp.onBudgetExhausted ?? 'warn',
    detectOscillation: fp.detectOscillation ?? true,
  };
}

function eolOf(doc: IRDocument): '\n' | '\r\n' {
  for (const src of doc.sources.values()) return src.eol;
  return '\n';
}

// `performance` is a host global (node20 / browser) not covered by the ES2023 lib;
// declared minimally so the runtime feature-detection below stays type-safe.
declare const performance: { now(): number } | undefined;

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** Build the pure single-file {@link Pipeline}. */
export function createPipeline(): Pipeline {
  return new DefaultPipeline();
}
