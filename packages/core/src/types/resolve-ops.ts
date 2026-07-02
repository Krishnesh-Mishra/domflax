/**
 * @domflax/core — type contract, part 2/3: diagnostics, the style-resolver layer, the selector
 * index, and the RewriteOp union + factory.
 *
 * Pure type/interface declarations only: ZERO runtime. Depends only on the IR/style primitives in
 * `./ir`.
 */

import type {
  CssProperty,
  DeepReadonly,
  DistributiveOmit,
  ElementSpec,
  IRElement,
  IRNode,
  IRNodeId,
  NodeSpec,
  PassCategory,
  PassPhase,
  PatternName,
  SafetyLevel,
  SourceSpan,
  StyleMap,
  StyleNormalizer,
} from './ir';

/* ────────────────────────────────────────────────────────────────────────── *
 * 10. Diagnostics (D7: string-literal union; runtime frozen object in constants.ts)
 * ────────────────────────────────────────────────────────────────────────── */

export type Severity = 'error' | 'warn' | 'info' | 'debug';

export type DiagnosticCode =
  | 'DF_PATTERN_THREW'
  | 'DF_OP_PRECONDITION_FAILED'
  | 'DF_CROSSED_DYNAMIC_BOUNDARY'
  | 'DF_SAFETY_CEILING_EXCEEDED'
  | 'DF_STYLE_CONFLICT_UNRESOLVED'
  | 'DF_FIXPOINT_BUDGET'
  | 'DF_FIXPOINT_OSCILLATION'
  | 'DF_NON_INHERITABLE_FOLD'
  | 'DF_RELATIVE_UNIT_FOLD'        // review-1: refused relative-unit fold
  | 'DF_CUSTOM_PROP_COUPLING'      // review-1: author --* coupling across wrapper
  | 'DF_STRUCTURAL_PSEUDO_TARGET'  // review-1: :nth/:only-child dependent
  | 'DF_SELECTOR_MEMBERSHIP'       // review-1: class used by project selector (compress)
  | 'DF_NODE_REMOVED'
  | 'DF_PATTERN_APPLIED'
  | 'DF_VERIFY_REVERTED'
  | 'DF_VERIFY_INCONCLUSIVE';

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly severity: Severity;
  readonly message: string;
  readonly span?: SourceSpan;
  readonly nodeId?: IRNodeId;
  readonly pattern?: PatternName;
  readonly phase?: PassPhase;
  readonly iteration?: number;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

export interface PassTraceEntry {
  readonly phase: PassPhase;
  readonly iteration: number;
  readonly pattern: PatternName;
  readonly nodeId: IRNodeId;
  readonly opCount: number;
}

export interface Reporter {
  report(d: Diagnostic): void;
  trace?(e: PassTraceEntry): void;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * 11. Style resolver layer
 * ────────────────────────────────────────────────────────────────────────── */

export type OpaqueReason =
  | 'combinator-variant'
  | 'container-query'
  | 'tw-var-coupling'        // Tailwind --tw-* internals
  | 'author-var-coupling'    // author-defined --* read by a descendant (review-1)
  | 'descendant-selector'
  | 'structural-pseudo'      // class participates in :nth/:only/etc. (review-1)
  | 'compound-membership'    // .btn.primary / :has() argument (review-1 compress)
  | 'dynamic-at-rule'
  | 'unsupported-unit'
  | 'arbitrary-property';

export interface OpaqueToken {
  readonly token: string;
  readonly reason: OpaqueReason;
  readonly detail?: string;
}

export interface ResolverDiagnostic {
  readonly severity: Severity;
  readonly message: string;
  readonly token?: string;
}

export interface ResolveInput {
  readonly classes: readonly string[];
  readonly inlineStyle?: string;
  readonly element?: { readonly tagName: string; readonly namespace?: 'html' | 'svg' };
}

export interface ResolveResult {
  readonly styles: StyleMap;
  readonly resolved: readonly string[];
  readonly unknown: readonly string[];
  readonly opaque: readonly OpaqueToken[];
  readonly warnings: readonly ResolverDiagnostic[];
}

/** How a class participates in project selectors — drives compress safety (review-1). */
export interface SelectorUsage {
  readonly asSubject: boolean;       // .x { }  — own styles, safe to rewrite
  readonly asAncestor: boolean;      // .x .y  — descendant hook
  readonly asCompound: boolean;      // .x.y / .x:hover — compound qualifier
  readonly asSibling: boolean;       // .x + y / .x ~ y
  readonly asHasArgument: boolean;   // :has(.x)
  readonly asStructural: boolean;    // .x:nth-child(...) etc.
  /** True iff the class is referenced ONLY as a plain subject — i.e. safe to drop/rename. */
  readonly droppable: boolean;
  /**
   * NOT unconditionally droppable, but the resolver has VERIFIED it can re-emit the token's exact
   * full effect (e.g. a Tailwind variant token like `hover:px-4` whose condition chain round-trips).
   * Reverse-emit may drop such a token ONLY under a mandatory re-resolve equality backstop — if the
   * rewritten set does not reproduce the element's computed style exactly, the drop is discarded and
   * the conservative (droppable-only) behaviour is used instead.
   */
  readonly rebuildable?: boolean;
}

export interface SyntheticClass {
  readonly className: string; // df-${styleMapKey.slice(0,8)}
  readonly decls: StyleMap;
  readonly css: string;
}

export interface EmitContext {
  readonly normalizer: StyleNormalizer;
  readonly sink: SyntheticSink;
  readonly preserveTokens?: readonly string[]; // opaque/selector-bound tokens kept verbatim
  /**
   * The (droppable) class tokens the target style was derived FROM. They are offered to the
   * exact-cover engine as candidates alongside the enumerated vocabulary, guaranteeing FEASIBILITY
   * (the original tokens can always re-cover their own contribution ⇒ the rewrite is never worse
   * than the original) and letting arbitrary-value / variant tokens participate in the cover.
   */
  readonly sourceTokens?: readonly string[];
  readonly budgetMs?: number;
}

export interface SyntheticSink {
  register(s: SyntheticClass): string;
  drain(): readonly SyntheticClass[];
}

export interface EmitResult {
  readonly classes: readonly string[];
  readonly residual?: SyntheticClass;
  readonly exact: boolean;
  readonly warnings: readonly ResolverDiagnostic[];
}

export interface StyleResolver {
  readonly id: string;          // 'tailwind' | 'css'
  readonly provider: string;    // 'tailwindcss@4.0.0'
  readonly fingerprint: string; // busts caches when theme/config/source CSS changes
  owns(token: string): boolean;
  resolve(input: ResolveInput): ResolveResult;                  // forward
  emit(styles: StyleMap, ctx: EmitContext): EmitResult;         // reverse
  /** Reports every project selector referencing a class — compress safety (review-1 major). */
  selectorUsage(token: string): SelectorUsage;
  /**
   * OPTIONAL: produce a CSS stylesheet that defines the given class tokens, so a verifier can render
   * a subtree with the provider's real styling applied. Tailwind generates the rules from its engine;
   * the custom-CSS resolver returns its source stylesheets. Resolvers that cannot (the null/fake test
   * resolvers) simply omit this — the verifier then falls back to inlining each element's computed style.
   */
  cssFor?(classes: readonly string[]): string;
  /**
   * OPTIONAL (CASCADE SAFETY for the inline-style ⇄ class converter): true when some project selector
   * OTHER than the element's own fully-modelled single-class rules could set `property` on an element
   * with this tag + class list (a bare `div { padding: … }` rule, a descendant/combinator subject, a
   * compound selector, …). Inline `style` beats every selector, so moving a declaration into a class
   * may flip the winner whenever such a competing rule exists — the converter therefore SKIPS any
   * property this reports `true` for. Providers whose entire style surface is class-keyed utilities
   * (Tailwind) omit it; the custom-CSS resolver implements it from its project stylesheets.
   */
  competesWith?(input: CompetesInput): boolean;
}

/** Input for {@link StyleResolver.competesWith}: the element's shape + the property being converted. */
export interface CompetesInput {
  readonly tagName: string;
  readonly classes: readonly string[];
  readonly property: CssProperty;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * 12. Selector index (precomputed targeting facts)
 * ────────────────────────────────────────────────────────────────────────── */

export interface SelectorIndex {
  targetedByCombinator(id: IRNodeId): boolean;
  targetedByStructuralPseudo(id: IRNodeId): boolean;
  /**
   * Set of node ids whose combinator / structural-pseudo match-set would CHANGE if `id` were
   * unwrapped/removed (self, child, and former siblings). Empty ⇒ structurally safe.
   * (review-1 blocker: guard the child & siblings, not just the wrapper.)
   */
  reparentImpact(id: IRNodeId): ReadonlySet<IRNodeId>;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * 13. RewriteOp (closed discriminated union) + factory (emits DRAFTS = origin-free data)
 * ────────────────────────────────────────────────────────────────────────── */

export interface OpOrigin {
  readonly pattern: PatternName;
  readonly category: PassCategory;
  readonly safety: SafetyLevel;
}

export type StyleConflictPolicy = 'target-wins' | 'source-wins' | 'abort';

export type RewriteOp =
  | { readonly op: 'removeNode'; readonly target: IRNodeId; readonly origin: OpOrigin }
  | { readonly op: 'unwrap'; readonly target: IRNodeId; readonly origin: OpOrigin }
  | { readonly op: 'replaceWith'; readonly target: IRNodeId; readonly replacement: NodeSpec; readonly origin: OpOrigin }
  | { readonly op: 'wrap'; readonly target: IRNodeId; readonly wrapper: ElementSpec; readonly origin: OpOrigin }
  | { readonly op: 'insertBefore'; readonly anchor: IRNodeId; readonly node: NodeSpec; readonly origin: OpOrigin }
  | { readonly op: 'insertAfter'; readonly anchor: IRNodeId; readonly node: NodeSpec; readonly origin: OpOrigin }
  | { readonly op: 'moveNode'; readonly target: IRNodeId; readonly newParent: IRNodeId; readonly index: number; readonly origin: OpOrigin }
  | { readonly op: 'mergeSiblings'; readonly first: IRNodeId; readonly second: IRNodeId; readonly origin: OpOrigin }
  | { readonly op: 'setClassList'; readonly target: IRNodeId; readonly style: StyleMap; readonly preserveOpaque: boolean; readonly origin: OpOrigin }
  | { readonly op: 'mergeStyle'; readonly target: IRNodeId; readonly source: IRNodeId | null; readonly style: StyleMap; readonly onConflict: StyleConflictPolicy; readonly origin: OpOrigin }
  | { readonly op: 'foldInheritedStyles'; readonly from: IRNodeId; readonly into: readonly IRNodeId[]; readonly properties: readonly CssProperty[] | 'all-inherited'; readonly conditions: 'base' | 'all'; readonly origin: OpOrigin };

/** Author-emitted op data: identical union minus `origin` (the scheduler stamps origin). */
export type RewriteOpDraft = DistributiveOmit<RewriteOp, 'origin'>;

export type ElementLike = IRElement | DeepReadonly<IRElement>;
export type NodeLike = IRNode | DeepReadonly<IRNode>;

/**
 * Pattern-kit's factory: produces op DRAFTS (no origin) and builds detached NodeSpecs purely —
 * it never touches doc.alloc/doc.nodes, so `evaluate` stays pure (review-2).
 */
export interface RewriteFactory {
  // structural
  unwrap(target: ElementLike): RewriteOpDraft;
  removeNode(target: NodeLike): RewriteOpDraft;
  replaceWith(target: NodeLike, replacement: NodeSpec): RewriteOpDraft;
  wrap(target: NodeLike, wrapper: ElementSpec): RewriteOpDraft;
  insertBefore(anchor: NodeLike, node: NodeSpec): RewriteOpDraft;
  insertAfter(anchor: NodeLike, node: NodeSpec): RewriteOpDraft;
  moveNode(target: NodeLike, newParent: ElementLike, index: number): RewriteOpDraft;
  mergeSiblings(first: NodeLike, second: NodeLike): RewriteOpDraft;
  // style
  setClassList(target: ElementLike, style: StyleMap, preserveOpaque?: boolean): RewriteOpDraft;
  mergeStyle(target: ElementLike, source: ElementLike | null, style: StyleMap, onConflict?: StyleConflictPolicy): RewriteOpDraft;
  /**
   * Folds inheritable declarations. `conditions:'all'` folds across every StyleCondition
   * (states/media/pseudo-element), not just BASE_CONDITION (review-1 major). Relative-unit
   * declarations are rejected by the applier with DF_RELATIVE_UNIT_FOLD.
   */
  foldInheritedStyles(
    from: ElementLike,
    into: ElementLike | readonly ElementLike[],
    opts?: { only?: readonly CssProperty[]; conditions?: 'base' | 'all' },
  ): RewriteOpDraft;
  // pure node-builders (return detached specs; no allocation)
  element(spec: ElementSpec): NodeSpec;
  text(value: string): NodeSpec;
  keep(node: NodeLike): NodeSpec; // reuse an existing node by id (preserves IRNodeId)
}
