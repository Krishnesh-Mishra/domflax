/**
 * @domflax/core — type contract, part 1/3: IR + style primitives.
 *
 * Pure type/interface declarations only: ZERO runtime. Covers type utilities, identity
 * primitives, source spans, the StyleMap model, NodeMeta, author tokens, the IR node union,
 * the expr registry / document, traversal types, and node specs. This is the bottom layer of
 * the type contract — it imports nothing from the sibling type modules.
 *
 * (`PassPhase`/`PassCategory` live here too, in the primitive layer, so the resolver/op modules
 * can reference them without a cycle through the pass-contract module.)
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
 * 1b. Pass phase / category (primitive string unions — kept in the base layer so the
 *     resolver + op modules can reference them without depending on the pass contract).
 * ────────────────────────────────────────────────────────────────────────── */

export type PassPhase = 'flatten' | 'compress' | 'extract';
export type PassCategory = `${PassPhase}/${string}`;

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
  /**
   * SAFETY (Layer 2): at least one of THIS element's static class tokens could not be resolved by the
   * style provider — a real, non-empty token that yielded no declarations and is not a known no-op
   * utility (e.g. a Tailwind-v4 project the v3 resolver cannot drive, a JS-hook class like `js-toggle`,
   * or a typo). The element's TRUE style is therefore UNKNOWN, so it must be treated as OPAQUE for
   * flatten purposes (never removed/unwrapped as "inert"). Set by the frontends from
   * `ResolveResult.unknown`; distinct from an element that RESOLVED to no paint (all tokens known,
   * collectively non-painting) which stays flatten-eligible. Compress is unaffected — it only rewrites
   * the element's own RESOLVED tokens and preserves unknown ones verbatim.
   */
  hasUnresolvedClasses: boolean;

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
  /**
   * A rewrite pass DIRECTLY rewrote THIS element's own computed style (setClassList / mergeStyle onto
   * it / foldInheritedStyles into it). Distinct from {@link touched}, which is ALSO raised when a
   * neighbour op (a child's `unwrap`, a sibling `mergeSiblings`/`moveNode`, an `insert`/`replaceWith`)
   * marks this node as a structural bystander WITHOUT changing its computed. Reverse-emit re-derives
   * class tokens ONLY for `styleDirty` elements, so a bystander keeps its `class` attribute byte-for-
   * byte identical (it can never gain a redundant class it did not already carry).
   */
  styleDirty: boolean;
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

/**
 * One segment of a class list. A STATIC segment whose `span` is set inside a `hasDynamic` list is
 * SURGICALLY REWRITABLE: the span is the exact splice region for the segment's token text — the
 * string literal's CONTENTS (quotes excluded) for a `cn("…")` argument, or one template-literal
 * quasi chunk (backticks/`${` excluded). The backend overwrites ONLY that region, preserving the
 * segment's leading/trailing whitespace, so every dynamic part stays byte-for-byte identical.
 * A static segment WITHOUT a span is never rewritten.
 */
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
  /**
   * The WHOLE dynamic className expression (`cn(…)` call / template literal) interned verbatim, set
   * when the frontend split it into mixed static/dynamic segments. Used only by the structural
   * re-print fallback so a multi-segment list is reproduced as its original expression.
   */
  readonly wholeExpr?: ExprRef;
}

export type AttrValue =
  | { readonly kind: 'static'; readonly value: string | boolean; readonly span?: SourceSpan }
  | { readonly kind: 'dynamic'; readonly expr: ExprRef; readonly span?: SourceSpan };

export interface AttrMap {
  readonly entries: ReadonlyMap<string, AttrValue>;
  readonly spreads: readonly ExprRef[];
  readonly order: readonly string[];
}

/**
 * One AUTHOR-WRITTEN declaration of a static `style` attribute, kept verbatim so the backend can
 * re-serialize the surviving declarations byte-identically after the inline-style ⇄ class converter
 * moved some of them into classes. `decls` is the declaration's normalized longhand expansion (the
 * shape the converter matches against the compress cover).
 */
export interface InlineStyleRawDecl {
  /** Verbatim author text (HTML: `prop: value`; JSX: the `key: value` object-property source slice). */
  readonly text: string;
  /** Normalized longhand declarations this author declaration sets. */
  readonly decls: readonly StyleDecl[];
  readonly important: boolean;
}

export interface InlineStyle {
  readonly decls: ReadonlyMap<CssProperty, StyleDecl>;
  readonly dynamic: readonly ExprRef[] | null; // style={expr} → blocks style folding
  readonly span?: SourceSpan;
  /**
   * The author's declarations in source order (STATIC attributes only — see the frontends). Present
   * iff the whole attribute was provably static, which is what makes the element eligible for the
   * inline-style ⇄ class converter; any dynamic value leaves this unset (attribute untouched).
   */
  readonly raw?: readonly InlineStyleRawDecl[];
  /**
   * Set by the inline-style ⇄ class converter when it rewrote this attribute (`raw` now holds only
   * the SURVIVING declarations; empty ⇒ the whole attribute is removed). The backends splice the
   * attribute span only when this is set, so untouched attributes stay byte-for-byte identical.
   */
  readonly dirty?: boolean;
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
