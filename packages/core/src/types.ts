/**
 * @domflax/core — public type contract (packages/core/src/types.ts)
 *
 * SINGLE SOURCE OF TRUTH for the whole monorepo. Pure type/interface declarations
 * only: ZERO runtime. Every downstream package imports these exact names.
 *
 * Compiles under: strict, verbatimModuleSyntax, isolatedDeclarations, erasableSyntaxOnly,
 * isolatedModules. No `const enum` (TS6 erasableSyntaxOnly): every closed set is a
 * string/number literal UNION here; the matching frozen `as const` runtime objects live in
 * sibling runtime modules (constants.ts), not in this file.
 */

/* ────────────────────────────────────────────────────────────────────────── *
 * 0. Type utilities
 * ────────────────────────────────────────────────────────────────────────── */

export type Brand<T, B extends string> = T & { readonly __brand: B };

/** Distributive Omit that preserves discriminated-union narrowing. */
export type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/**
 * Deep-immutable view. The pass manager hands patterns a DeepReadonly<IRElement>/
 * DeepReadonly<IRDocument> so invariant #4 ("rule authors can never mutate the IR") is a
 * COMPILE-TIME guarantee, not a convention (review-2 blocker). In dev the runtime additionally
 * wraps these in a throw-on-write Proxy.
 */
export type DeepReadonly<T> =
  T extends (...args: never[]) => unknown ? T :
  T extends ReadonlyMap<infer K, infer V> ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>> :
  T extends ReadonlySet<infer U> ? ReadonlySet<DeepReadonly<U>> :
  T extends Map<infer K, infer V> ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>> :
  T extends Set<infer U> ? ReadonlySet<DeepReadonly<U>> :
  T extends readonly (infer U)[] ? readonly DeepReadonly<U>[] :
  T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } :
  T;

/* ────────────────────────────────────────────────────────────────────────── *
 * 1. Identity primitives (D1: branded numbers)
 * ────────────────────────────────────────────────────────────────────────── */

export type IRNodeId = Brand<number, 'IRNodeId'>;
export type SourceFileId = Brand<number, 'SourceFileId'>;
export type ExprRef = Brand<number, 'ExprRef'>;
export type PatternName = string;

export interface IdAllocator {
  next(): IRNodeId;
  /** Peek the next id without consuming, for deterministic dry-run validation. */
  readonly peek: IRNodeId;
}

/** SAFETY: 0 lint · 1 safe · 2 default · 3 aggressive. (Runtime `SAFETY` object lives in constants.ts.) */
export type SafetyLevel = 0 | 1 | 2 | 3;

/* ────────────────────────────────────────────────────────────────────────── *
 * 2. Source spans (canonical UTF-16 code-unit offsets)
 * ────────────────────────────────────────────────────────────────────────── */

export interface Position {
  readonly line: number;
  readonly column: number;
}

export interface SourceSpan {
  readonly file: SourceFileId;
  readonly start: number; // inclusive, UTF-16 code units
  readonly end: number;   // exclusive
  readonly startLoc?: Position;
  readonly endLoc?: Position;
}

export type FileKind = 'jsx' | 'tsx' | 'html' | 'unknown';
export type FrontendKind = 'jsx' | 'html';

export interface SourceFile {
  readonly id: SourceFileId;
  readonly path: string;
  readonly text: string; // verbatim source, retained for surgical codegen
  readonly frontend: FrontendKind;
  readonly eol: '\n' | '\r\n';
  readonly indentUnit: string;
  native?: unknown; // frontend-private AST root; released after codegen
}

/* ────────────────────────────────────────────────────────────────────────── *
 * 3. StyleMap (D2: condition-keyed blocks + per-decl provenance)
 * ────────────────────────────────────────────────────────────────────────── */

export type CssProperty = Brand<string, 'CssProperty'>; // canonical LONGHAND, kebab-case
export type CssValue = Brand<string, 'CssValue'>;        // normalized serialization
export type ConditionKey = Brand<string, 'ConditionKey'>;
export type DeclSignature = Brand<string, 'DeclSignature'>;

export interface StyleCondition {
  readonly media: string;              // '' = unconditional; container queries OPAQUE in v1
  readonly states: readonly string[];  // sorted, de-duped, e.g. [':focus',':hover']
  readonly pseudoElement: string;      // '' | '::before' | '::placeholder' ...
}

export type StyleOrigin =
  | { readonly kind: 'class'; readonly tokenIndex: number; readonly className: string }
  | { readonly kind: 'inline' }
  | { readonly kind: 'inherited'; readonly from: IRNodeId }
  | { readonly kind: 'synthetic' };

/**
 * `relativeToParent` is set when the value uses a parent-relative unit (em/ex/ch/%/lh, or
 * font-relative line-height). The applier REFUSES to fold such a declaration onto a child whose
 * font-size/inline reference differs (review-1 major: relative-unit fold). Computed by the
 * normalizer at parse time (purely syntactic detection — no value resolution).
 */
export interface StyleDecl {
  readonly property: CssProperty;
  readonly value: CssValue;
  readonly important: boolean;
  readonly relativeToParent: boolean;
  readonly inherited: boolean; // property is in the canonical inherited-property table
  readonly origin?: StyleOrigin;
  readonly shadowed?: readonly StyleOrigin[];
}

export interface StyleBlock {
  readonly condition: StyleCondition;
  readonly decls: ReadonlyMap<CssProperty, StyleDecl>; // longhand only; property-sorted
}

export interface StyleMap {
  readonly blocks: ReadonlyMap<ConditionKey, StyleBlock>;
}

/**
 * Canonical, versioned set of inherited CSS properties (review-1 major: fold allowlist
 * completeness). The SINGLE source consumed by foldInheritedStyles, hasOwnVisualStyle reasoning,
 * and the verifier. Includes author custom properties via the `--` predicate handled in runtime.
 */
export interface InheritedPropertyTable {
  readonly version: string;
  readonly properties: ReadonlySet<CssProperty>;
  isInherited(property: CssProperty): boolean; // true for any `--*` custom property too
}

/**
 * Syntactic-only normalizer (shorthand expansion, color/unit canonicalization, ordering).
 * NEVER resolves initial/inherited/computed defaults — that is the verifier's job. The SAME
 * instance/version is shared by resolver + patterns + verifier (correctness lynchpin).
 */
export interface StyleNormalizer {
  readonly version: string;
  normalizeDeclaration(prop: string, value: string, important: boolean): readonly StyleDecl[];
  normalizeValue(prop: CssProperty, raw: string): CssValue;
  normalizeStyleMap(sm: StyleMap): StyleMap;
  equals(a: StyleMap, b: StyleMap): boolean;
  readonly inherited: InheritedPropertyTable;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * 4. NodeMeta — opacity barriers + CSS-targeting awareness + codegen
 * ────────────────────────────────────────────────────────────────────────── */

export interface NodeMeta {
  // hard opacity barriers (frontend-set)
  hasRef: boolean;
  hasEventHandlers: boolean;
  hasKey: boolean;
  hasSpreadAttrs: boolean;
  hasDynamicChildren: boolean;
  isComponent: boolean;
  hasDangerousHtml: boolean;

  // CSS-targeting awareness (SelectorIndex-derived)
  targetedByCombinator: boolean;       // > + ~ subject
  targetedByStructuralPseudo: boolean; // :first/last/only/nth-child/of-type (review-1 blocker)
  selectorDependents: number;

  // box / formatting / paint establishment (review-1 + review-4 blockers)
  hasOwnVisualStyle: boolean;          // across ALL StyleConditions, incl. pseudo-elements & states
  establishesBox: boolean;             // intrinsic/explicit sizing
  establishesStackingContext: boolean; // position!=static+z, transform, filter, opacity<1, will-change, isolation, mix-blend, contain, perspective, clip-path/mask
  isContainingBlock: boolean;          // containing block for abs/fixed descendants
  establishesFormattingContext: boolean;
  declaresCustomProperties: boolean;   // sets any `--*` read by a descendant (review-1 major)
  whitespaceSensitive: boolean;

  // codegen
  touched: boolean;
  synthetic: boolean;
  safetyFloor: SafetyLevel; // a pass with safety > floor may NOT modify this node
}

/* ────────────────────────────────────────────────────────────────────────── *
 * 5. Author tokens: ClassList / AttrMap / InlineStyle
 * ────────────────────────────────────────────────────────────────────────── */

export interface ClassToken {
  readonly value: string;
  readonly span?: SourceSpan;
}

export type ClassSegment =
  | { readonly kind: 'static'; readonly span?: SourceSpan; readonly tokens: readonly ClassToken[] }
  | { readonly kind: 'dynamic'; readonly span?: SourceSpan; readonly expr: ExprRef };

export type ClassListForm =
  | 'string-literal' | 'template-literal' | 'call' | 'conditional' | 'member' | 'absent';

export interface ClassList {
  readonly form: ClassListForm;
  readonly segments: readonly ClassSegment[];
  readonly valueSpan: SourceSpan | null; // splice target for setClassList
  readonly attrSpan?: SourceSpan;
  readonly hasDynamic: boolean;
  readonly opaque: boolean;     // wholly dynamic/spread-derived → never optimize
  readonly rewritable: boolean; // >=1 static segment AND splice-safe
}

export type AttrValue =
  | { readonly kind: 'static'; readonly value: string | boolean; readonly span?: SourceSpan }
  | { readonly kind: 'dynamic'; readonly expr: ExprRef; readonly span?: SourceSpan };

export interface AttrMap {
  readonly entries: ReadonlyMap<string, AttrValue>;
  readonly spreads: readonly ExprRef[];
  readonly order: readonly string[];
}

export interface InlineStyle {
  readonly decls: ReadonlyMap<CssProperty, StyleDecl>;
  readonly dynamic: readonly ExprRef[] | null; // style={expr} → blocks style folding
  readonly span?: SourceSpan;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * 6. IR nodes (D3 union)
 * ────────────────────────────────────────────────────────────────────────── */

export type IRNodeKind = 'element' | 'text' | 'expr' | 'fragment' | 'comment';
export type IRNamespace = 'html' | 'svg' | 'mathml' | 'component';

export interface IRNodeBase {
  readonly id: IRNodeId;
  readonly kind: IRNodeKind;
  parent: IRNodeId | null;
  span: SourceSpan | null; // null = synthetic
  meta: NodeMeta;
}

export interface IRElement extends IRNodeBase {
  readonly kind: 'element';
  tag: string;
  namespace: IRNamespace;
  isComponent: boolean;
  selfClosing: boolean;
  classes: ClassList;
  inlineStyle: InlineStyle;
  computed: StyleMap; // RESOLVED + NORMALIZED (class+inline) — patterns match HERE
  attrs: AttrMap;
  children: IRNodeId[];
}

export interface IRText extends IRNodeBase {
  readonly kind: 'text';
  value: string;
  collapsible: boolean;
}

export interface IRExpr extends IRNodeBase {
  readonly kind: 'expr';
  expr: ExprRef; // dynamic child / template island
}

export interface IRFragment extends IRNodeBase {
  readonly kind: 'fragment';
  children: IRNodeId[];
}

export interface IRComment extends IRNodeBase {
  readonly kind: 'comment';
  value: string;
}

export type IRNode = IRElement | IRText | IRExpr | IRFragment | IRComment;

/* ────────────────────────────────────────────────────────────────────────── *
 * 7. Expr registry, backref table, the one document
 * ────────────────────────────────────────────────────────────────────────── */

export type ExprKind =
  | 'call' | 'member' | 'conditional' | 'template' | 'identifier' | 'spread' | 'other';

export interface ExprRecord {
  readonly ref: ExprRef;
  readonly span: SourceSpan;
  readonly kind: ExprKind;
  payload?: unknown;
}

export interface ExprRegistry {
  get(r: ExprRef): ExprRecord | undefined;
  intern(rec: Omit<ExprRecord, 'ref'>): ExprRef;
  releasePayloads(): void;
}

export interface Backref {
  readonly nodeId: IRNodeId;
  readonly span: SourceSpan;
  readonly openTagSpan: SourceSpan | null;
  readonly closeTagSpan: SourceSpan | null;
  readonly innerSpan: SourceSpan | null;
  readonly selfClosing: boolean;
}

export interface BackrefTable {
  get(id: IRNodeId): Backref | undefined;
  span(id: IRNodeId): SourceSpan | null;
  childrenSpan(id: IRNodeId): SourceSpan | null;
}

/** ONE document type (D9): absorbs IRModule / SourceModule. */
export interface IRDocument {
  root: IRNodeId; // always a fragment
  nodes: Map<IRNodeId, IRNode>;
  exprs: ExprRegistry;
  sources: Map<SourceFileId, SourceFile>;
  backref: BackrefTable;
  frontend: FrontendKind;
  alloc: IdAllocator;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * 8. Traversal (types only; walk/iter are runtime)
 * ────────────────────────────────────────────────────────────────────────── */

export type VisitSignal = void | 'skip' | 'stop';

export interface VisitContext {
  readonly doc: DeepReadonly<IRDocument>;
  readonly depth: number;
  parent(): IRNode | null;
}

export interface Visitor {
  enter?(n: IRNode, c: VisitContext): VisitSignal;
  exit?(n: IRNode, c: VisitContext): VisitSignal;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * 9. Node specs — detached, id-free node descriptions for synthesis
 *    (review-2 major: replaceWith/wrap need a node the pure factory can build without
 *     touching doc.alloc/doc.nodes; the applier materializes ids during apply.)
 * ────────────────────────────────────────────────────────────────────────── */

export interface ElementSpec {
  readonly kind: 'element';
  readonly tag: string;
  readonly namespace?: IRNamespace;
  readonly classes?: StyleMap;            // applier reverse-emits to a class list
  readonly attrs?: ReadonlyMap<string, string | boolean>;
  readonly children?: readonly NodeSpec[];
  readonly selfClosing?: boolean;
}
export interface TextSpec { readonly kind: 'text'; readonly value: string }
export interface ExprSpec { readonly kind: 'expr'; readonly expr: ExprRef }
export interface FragmentSpec { readonly kind: 'fragment'; readonly children: readonly NodeSpec[] }
export interface CommentSpec { readonly kind: 'comment'; readonly value: string }
/** Reuse an existing live node (preserves its IRNodeId — D10). */
export interface NodeRefSpec { readonly kind: 'ref'; readonly ref: IRNodeId }

export type NodeSpec =
  | ElementSpec | TextSpec | ExprSpec | FragmentSpec | CommentSpec | NodeRefSpec;

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

/* ────────────────────────────────────────────────────────────────────────── *
 * 14. Pattern contract (D4: single pure evaluate) + match/rewrite contexts
 * ────────────────────────────────────────────────────────────────────────── */

export type PassPhase = 'flatten' | 'compress' | 'extract';
export type PassCategory = `${PassPhase}/${string}`;

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
