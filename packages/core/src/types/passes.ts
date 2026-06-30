/**
 * @domflax/core — type contract, part 3/3: the pattern contract + match/rewrite contexts, the pass
 * manager + applier, frontends/backends, and the pure single-file pipeline.
 *
 * Pure type/interface declarations only: ZERO runtime. Depends on the IR/style primitives in `./ir`
 * and the resolver/op types in `./resolve-ops`.
 */

import type {
  DeepReadonly,
  FileKind,
  IRDocument,
  IRElement,
  IRNode,
  IRNodeId,
  NodeMeta,
  PassCategory,
  PassPhase,
  PatternName,
  SafetyLevel,
  SourceSpan,
  StyleMap,
  StyleNormalizer,
} from './ir';
import type {
  Diagnostic,
  DiagnosticCode,
  ElementLike,
  NodeLike,
  Reporter,
  RewriteFactory,
  RewriteOp,
  RewriteOpDraft,
  SelectorIndex,
  StyleResolver,
  SyntheticSink,
} from './resolve-ops';

/* ────────────────────────────────────────────────────────────────────────── *
 * 14. Pattern contract (D4: single pure evaluate) + match/rewrite contexts
 * ────────────────────────────────────────────────────────────────────────── */

export type Captures = Record<string, unknown>;

/** Read-only style predicate over a normalized StyleMap (queries MEANING, not strings). */
export type StylePredicate = (sm: StyleMap) => boolean;

/**
 * Relational precondition (review-2 blocker): describes ancestor/sibling/child subtree shape AND
 * ancestor LAYOUT context (review-4 blocker) so fuzzProve generates trees that exercise the
 * relational + parent-constraint branches, not just node-local ones.
 */
export interface TreeShapeSketch {
  readonly tag?: string | readonly string[];
  readonly requiredComputed?: Readonly<Record<string, string>>;
  readonly meta?: Partial<Record<keyof NodeMeta, boolean>>;
  readonly children?: readonly TreeShapeSketch[];
}

export type ParentLayoutContext =
  | 'block-flow' | 'flex-item' | 'flex-item-stretch' | 'grid-item'
  | 'fixed-size-ancestor' | 'percentage-sized-child' | 'inline-context';

export interface PreconditionSketch {
  readonly requiredComputed?: Readonly<Record<string, string>>;
  readonly childCount?: { readonly min?: number; readonly max?: number };
  readonly forbid?: readonly string[];
  readonly ancestor?: TreeShapeSketch;          // relational shape upward
  readonly siblings?: readonly TreeShapeSketch[];
  readonly childShapes?: readonly TreeShapeSketch[];
  readonly parentContexts?: readonly ParentLayoutContext[]; // fuzz must cover each
}

export interface PatternDoc {
  readonly title: string;
  readonly summary: string;
  readonly before?: string;
  readonly after?: string;
  readonly safetyRationale?: string;
}

/** Result of a successful match: op drafts (origin stamped later) + optional captures/diagnostics. */
export interface MatchResult<C extends Captures = Captures> {
  readonly ops: readonly RewriteOpDraft[];
  readonly captures?: C;
  readonly diagnostics?: readonly Diagnostic[];
}

export interface MatchContext {
  readonly node: DeepReadonly<IRElement>;
  readonly doc: DeepReadonly<IRDocument>;
  readonly resolver: StyleResolver;
  readonly selectors: SelectorIndex;
  readonly safety: SafetyLevel;
  readonly phase: PassPhase;
  readonly iteration: number;

  // node-local
  parent(): DeepReadonly<IRElement> | null;
  elementChildren(): readonly DeepReadonly<IRElement>[];
  onlyElementChild(): DeepReadonly<IRElement> | null;
  computed(): StyleMap;
  computedOf(n: NodeLike): StyleMap;
  isOpaque(n?: ElementLike): boolean;

  // relational read accessors (review-2 major: ancestor/sibling/child queries)
  ancestors(): readonly DeepReadonly<IRElement>[];
  closest(pred: (el: DeepReadonly<IRElement>) => boolean): DeepReadonly<IRElement> | null;
  prevSibling(): DeepReadonly<IRNode> | null;
  nextSibling(): DeepReadonly<IRNode> | null;
  nthChildIndex(): number; // structural-pseudo position among element siblings (1-based)
}

/** Context handed to the `rewrite` phase: a MatchContext plus the typed captures. */
export interface RewriteContext<C extends Captures = Captures> extends MatchContext {
  readonly captures: C;
}

export interface Pattern {
  readonly name: PatternName;
  readonly category: PassCategory;
  readonly safety: SafetyLevel;
  readonly priority?: number;
  readonly precondition?: PreconditionSketch;
  readonly doc?: PatternDoc;
  /** Pure. Returns a MatchResult (op drafts) or null on no-match. MUST NOT mutate. */
  evaluate(ctx: MatchContext, rw: RewriteFactory): MatchResult | null;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * 15. Pass manager + applier (the one trusted mutator)
 * ────────────────────────────────────────────────────────────────────────── */

export interface Pass {
  readonly phase: PassPhase;
  readonly category: PassCategory;
  readonly patterns: readonly Pattern[];
}

export interface FixpointConfig {
  readonly maxIterations: number;
  readonly phases: Partial<Record<PassPhase, number>>;
  readonly onBudgetExhausted: 'warn' | 'error';
  readonly detectOscillation: boolean;
}

export type HaltReason = 'converged' | 'budget' | 'oscillation' | 'error';

export interface PhaseRunResult {
  readonly phase: PassPhase;
  readonly iterations: number;
  readonly converged: boolean;
  readonly haltReason: HaltReason;
  readonly touched: ReadonlySet<IRNodeId>;
  readonly diagnostics: readonly Diagnostic[];
}

export interface RewriteGroup {
  readonly pattern: PatternName;
  readonly anchor: IRNodeId;
  readonly ops: readonly RewriteOp[];
}

/**
 * VERIFIER-GATED flatten policy (the "identical UI" safety guarantee).
 *
 *   • `'all'`             — commit every flatten the patterns produce (subject only to the existing
 *                            emittability revert). The historical behaviour; the pattern auto-test
 *                            harness runs in this mode so authored examples are validated in isolation.
 *   • `'provably-safe'`   — commit ONLY flattens that provably change nothing renderable (the wrapper
 *                            contributes no own box/formatting context and drops no style, and the
 *                            rewrite makes no parent-context assumption). Every other flatten is
 *                            reverted via the inverse journal. This is the default for the `domflax`
 *                            orchestrator + CLI: domflax never changes rendering by default, and it is
 *                            the ONLY user-facing behaviour — the transform is fully static and never
 *                            launches a browser.
 */
export type FlattenGate = 'all' | 'provably-safe';

export interface ApplyContext {
  readonly doc: IRDocument;
  readonly safetyCeiling: SafetyLevel;
  readonly normalizer: StyleNormalizer;
  readonly selectors: SelectorIndex;
  readonly resolver: StyleResolver;
  /** Flatten safety policy. Defaults to `'all'` when omitted (historical behaviour). */
  readonly gate?: FlattenGate;
}

export interface StructuralInverse {
  readonly kind: 'structural';
  readonly describe: string;
  readonly snapshot: unknown; // opaque journal payload, applied by revert()
}

export interface AppliedOp {
  readonly op: RewriteOp;
  readonly inverse: RewriteOp | StructuralInverse;
}

export interface OpValidationIssue {
  readonly op: RewriteOp;
  readonly code: DiagnosticCode;
  readonly message: string;
}

export interface SkippedOpGroup {
  readonly group: RewriteGroup;
  readonly issues: readonly OpValidationIssue[];
}

export interface ApplyResult {
  readonly touched: ReadonlySet<IRNodeId>;
  readonly removed: ReadonlySet<IRNodeId>;
  readonly created: ReadonlySet<IRNodeId>;
  readonly appliedGroups: number;
  readonly skipped: readonly SkippedOpGroup[];
  readonly journal: readonly AppliedOp[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface PassManager {
  run(doc: IRDocument, ctx: ApplyContext, config?: FixpointConfig): readonly PhaseRunResult[];
}

/* ────────────────────────────────────────────────────────────────────────── *
 * 16. Frontends & backends
 * ────────────────────────────────────────────────────────────────────────── */

export interface FrontendConfig {
  readonly jsxImportSource?: string;
  readonly preserveComments?: boolean;
  readonly [key: string]: unknown;
}

export interface FrontendParseContext {
  readonly id: string;
  readonly kind: FileKind;
  readonly resolver: StyleResolver;
  readonly normalizer: StyleNormalizer;
  readonly config: FrontendConfig;
  onDiagnostic(d: Diagnostic): void;
  babelAst?: unknown; // caller already owns a Babel AST → skip re-parse
}

export interface ParseResult {
  readonly doc: IRDocument;
  readonly diagnostics: readonly Diagnostic[];
}

export interface Frontend {
  readonly name: string;
  readonly langs: readonly FileKind[];
  canParse(id: string, code: string): boolean;
  parse(code: string, ctx: FrontendParseContext): ParseResult;
}

export interface ReindentSpec {
  readonly baseIndent: string;
  readonly delta: number;
}

export interface TextEdit {
  readonly span: SourceSpan;
  readonly replacement: string;
  readonly reindent?: ReindentSpec;
  readonly origin: string;
}

export interface EditPlan {
  readonly moduleId: string;
  readonly ops: readonly RewriteOp[];
  readonly provenance: ReadonlyMap<number, PatternName>;
}

export interface EncodedSourceMap {
  readonly version: 3;
  readonly sources: readonly string[];
  readonly sourcesContent?: readonly (string | null)[];
  readonly names: readonly string[];
  readonly mappings: string;
  readonly file?: string;
}

export interface BackendContext {
  readonly normalizer: StyleNormalizer;
  readonly resolver: StyleResolver;
  readonly sink: SyntheticSink;
  readonly eol: '\n' | '\r\n';
  onDiagnostic(d: Diagnostic): void;
}

export interface CodegenResult {
  readonly code: string;
  readonly map: EncodedSourceMap | null;
  readonly edits: readonly TextEdit[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface Backend {
  readonly name: string;
  readonly langs: readonly FileKind[];
  print(doc: IRDocument, plan: EditPlan, ctx: BackendContext): CodegenResult;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * 17. Pipeline (pure, single-file)
 * ────────────────────────────────────────────────────────────────────────── */

export interface PipelineConfig {
  readonly safety: SafetyLevel;
  readonly fixpoint?: Partial<FixpointConfig>;
  readonly preserveComments?: boolean;
  readonly emitSourceMap?: boolean;
}

export interface PipelineInput {
  readonly code: string;
  readonly id: string;
  readonly kind: FileKind;
  readonly frontend: Frontend;
  readonly backend: Backend;
  readonly resolver: StyleResolver;
  readonly normalizer: StyleNormalizer;
  readonly passes: readonly Pass[];
  readonly config?: PipelineConfig;
  readonly reporter?: Reporter;
  readonly babelAst?: unknown;
}

export interface PipelineStats {
  readonly nodesIn: number;
  readonly nodesOut: number;
  readonly opsApplied: number;
  readonly iterations: Readonly<Record<PassPhase, number>>;
  readonly durationMs: number;
}

export interface PipelineOutput {
  readonly code: string;
  readonly map: EncodedSourceMap | null;
  readonly changed: boolean;
  readonly touched: readonly SourceSpan[]; // output-space edited regions, for the verifier
  readonly diagnostics: readonly Diagnostic[];
  readonly stats: PipelineStats;
  readonly doc: IRDocument;
  readonly editPlan: EditPlan;
}

/** The pure single-file pipeline. Adapters/orchestrator call this; the verifier reuses it. */
export interface Pipeline {
  run(input: PipelineInput): PipelineOutput;
}
