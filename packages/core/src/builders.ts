/**
 * @domflax/core — runtime builders + traversal.
 *
 * Pure, dependency-free helpers to construct IR nodes, assemble an {@link IRDocument},
 * and walk the tree honouring {@link VisitSignal}. No heavy third-party deps: only the
 * type contract in `./types`.
 */

import type {
  AttrMap,
  Backref,
  BackrefTable,
  ClassList,
  ConditionKey,
  CssProperty,
  ExprRecord,
  ExprRef,
  ExprRegistry,
  FrontendKind,
  IdAllocator,
  IRComment,
  IRDocument,
  IRElement,
  IRExpr,
  IRFragment,
  IRNamespace,
  IRNode,
  IRNodeId,
  IRText,
  InlineStyle,
  NodeMeta,
  SafetyLevel,
  SourceSpan,
  StyleBlock,
  StyleCondition,
  StyleMap,
  Visitor,
  VisitContext,
  VisitSignal,
} from './types';

/* ───────────────────────── id / registry primitives ───────────────────────── */

/** Monotonic IRNodeId allocator. `peek` reports the id `next()` would return. */
export function createIdAllocator(start = 1): IdAllocator {
  let n = start;
  return {
    next(): IRNodeId {
      const id = n;
      n += 1;
      return id as IRNodeId;
    },
    get peek(): IRNodeId {
      return n as IRNodeId;
    },
  };
}

/** Minimal in-memory ExprRegistry. */
export function createExprRegistry(start = 1): ExprRegistry {
  const map = new Map<ExprRef, ExprRecord>();
  let n = start;
  return {
    get(r: ExprRef): ExprRecord | undefined {
      return map.get(r);
    },
    intern(rec: Omit<ExprRecord, 'ref'>): ExprRef {
      const ref = n as ExprRef;
      n += 1;
      map.set(ref, { ...rec, ref });
      return ref;
    },
    releasePayloads(): void {
      for (const [k, v] of map) map.set(k, { ...v, payload: undefined });
    },
  };
}

/** Mutable BackrefTable: frontends register backrefs as they parse. */
export interface MutableBackrefTable extends BackrefTable {
  set(id: IRNodeId, backref: Backref): void;
}

export function createBackrefTable(): MutableBackrefTable {
  const map = new Map<IRNodeId, Backref>();
  return {
    get(id: IRNodeId): Backref | undefined {
      return map.get(id);
    },
    span(id: IRNodeId): SourceSpan | null {
      return map.get(id)?.span ?? null;
    },
    childrenSpan(id: IRNodeId): SourceSpan | null {
      return map.get(id)?.innerSpan ?? null;
    },
    set(id: IRNodeId, backref: Backref): void {
      map.set(id, backref);
    },
  };
}

/* ───────────────────────── default sub-structures ───────────────────────── */

/** A NodeMeta with every barrier/flag cleared. */
export function defaultMeta(safetyFloor: SafetyLevel = 0): NodeMeta {
  return {
    hasRef: false,
    hasEventHandlers: false,
    hasKey: false,
    hasSpreadAttrs: false,
    hasDynamicChildren: false,
    isComponent: false,
    hasDangerousHtml: false,
    targetedByCombinator: false,
    targetedByStructuralPseudo: false,
    selectorDependents: 0,
    hasOwnVisualStyle: false,
    establishesBox: false,
    establishesStackingContext: false,
    isContainingBlock: false,
    establishesFormattingContext: false,
    declaresCustomProperties: false,
    whitespaceSensitive: false,
    touched: false,
    styleDirty: false,
    synthetic: false,
    safetyFloor,
  };
}

/** Canonical base style condition (`media:'' states:[] pseudoElement:''`). */
export const BASE_CONDITION: StyleCondition = { media: '', states: [], pseudoElement: '' };

/** Stable serialization of a StyleCondition into a ConditionKey. */
export function conditionKey(c: StyleCondition): ConditionKey {
  const states = [...c.states].sort().join(',');
  return `${c.media}|${states}|${c.pseudoElement}` as ConditionKey;
}

export const BASE_CONDITION_KEY: ConditionKey = conditionKey(BASE_CONDITION);

/** An empty StyleMap (no blocks). */
export function emptyStyleMap(): StyleMap {
  return { blocks: new Map<ConditionKey, StyleBlock>() };
}

/** An empty (absent) ClassList. */
export function emptyClassList(): ClassList {
  return {
    form: 'absent',
    segments: [],
    valueSpan: null,
    hasDynamic: false,
    opaque: false,
    rewritable: false,
  };
}

/** An empty AttrMap. */
export function emptyAttrMap(): AttrMap {
  return { entries: new Map(), spreads: [], order: [] };
}

/** An empty InlineStyle. */
export function emptyInlineStyle(): InlineStyle {
  return { decls: new Map<CssProperty, never>() as InlineStyle['decls'], dynamic: null };
}

/* ───────────────────────── node factories ───────────────────────── */

export interface ElementInit {
  readonly tag: string;
  readonly namespace?: IRNamespace;
  readonly isComponent?: boolean;
  readonly selfClosing?: boolean;
  readonly classes?: ClassList;
  readonly inlineStyle?: InlineStyle;
  readonly computed?: StyleMap;
  readonly attrs?: AttrMap;
  readonly children?: IRNodeId[];
  readonly parent?: IRNodeId | null;
  readonly span?: SourceSpan | null;
  readonly meta?: NodeMeta;
}

export function createElement(id: IRNodeId, init: ElementInit): IRElement {
  return {
    id,
    kind: 'element',
    parent: init.parent ?? null,
    span: init.span ?? null,
    meta: init.meta ?? defaultMeta(),
    tag: init.tag,
    namespace: init.namespace ?? 'html',
    isComponent: init.isComponent ?? false,
    selfClosing: init.selfClosing ?? false,
    classes: init.classes ?? emptyClassList(),
    inlineStyle: init.inlineStyle ?? emptyInlineStyle(),
    computed: init.computed ?? emptyStyleMap(),
    attrs: init.attrs ?? emptyAttrMap(),
    children: init.children ?? [],
  };
}

export function createText(
  id: IRNodeId,
  value: string,
  opts?: { collapsible?: boolean; parent?: IRNodeId | null; span?: SourceSpan | null },
): IRText {
  return {
    id,
    kind: 'text',
    parent: opts?.parent ?? null,
    span: opts?.span ?? null,
    meta: defaultMeta(),
    value,
    collapsible: opts?.collapsible ?? true,
  };
}

export function createExpr(
  id: IRNodeId,
  expr: ExprRef,
  opts?: { parent?: IRNodeId | null; span?: SourceSpan | null },
): IRExpr {
  return {
    id,
    kind: 'expr',
    parent: opts?.parent ?? null,
    span: opts?.span ?? null,
    meta: defaultMeta(),
    expr,
  };
}

export function createFragment(
  id: IRNodeId,
  opts?: { children?: IRNodeId[]; parent?: IRNodeId | null; span?: SourceSpan | null },
): IRFragment {
  return {
    id,
    kind: 'fragment',
    parent: opts?.parent ?? null,
    span: opts?.span ?? null,
    meta: defaultMeta(),
    children: opts?.children ?? [],
  };
}

export function createComment(
  id: IRNodeId,
  value: string,
  opts?: { parent?: IRNodeId | null; span?: SourceSpan | null },
): IRComment {
  return {
    id,
    kind: 'comment',
    parent: opts?.parent ?? null,
    span: opts?.span ?? null,
    meta: defaultMeta(),
    value,
  };
}

/** Build an empty document whose root is a fresh fragment. */
export function createDocument(frontend: FrontendKind): IRDocument {
  const alloc = createIdAllocator();
  const rootId = alloc.next();
  const root = createFragment(rootId);
  const nodes = new Map<IRNodeId, IRNode>([[rootId, root]]);
  return {
    root: rootId,
    nodes,
    exprs: createExprRegistry(),
    sources: new Map(),
    backref: createBackrefTable(),
    frontend,
    alloc,
  };
}

/* ───────────────────────── tree accessors ───────────────────────── */

/** Returns the child id list for container nodes, or an empty array. */
export function childIds(node: IRNode): readonly IRNodeId[] {
  return node.kind === 'element' || node.kind === 'fragment' ? node.children : [];
}

/** Returns the node, or undefined. */
export function getNode(doc: IRDocument, id: IRNodeId): IRNode | undefined {
  return doc.nodes.get(id);
}

/** Returns the node iff it is an element. */
export function getElement(doc: IRDocument, id: IRNodeId): IRElement | undefined {
  const n = doc.nodes.get(id);
  return n && n.kind === 'element' ? n : undefined;
}

/** Pre-order list of every element id reachable from the root. */
export function elementIds(doc: IRDocument): IRNodeId[] {
  const out: IRNodeId[] = [];
  const visit = (id: IRNodeId): void => {
    const n = doc.nodes.get(id);
    if (!n) return;
    if (n.kind === 'element') out.push(id);
    for (const c of childIds(n)) visit(c);
  };
  visit(doc.root);
  return out;
}

/* ───────────────────────── traversal ───────────────────────── */

/**
 * Depth-first pre/post-order walk. `enter` may return `'skip'` (don't descend) or `'stop'`
 * (abort the whole walk); `exit` may return `'stop'`. The visitor receives a live {@link IRNode}
 * plus a {@link VisitContext} exposing depth and the parent node.
 */
export function walk(doc: IRDocument, visitor: Visitor): void {
  const roDoc = doc as unknown as VisitContext['doc'];
  let stopped = false;

  const visit = (id: IRNodeId, depth: number): void => {
    if (stopped) return;
    const node = doc.nodes.get(id);
    if (!node) return;

    const ctx: VisitContext = {
      doc: roDoc,
      depth,
      parent(): IRNode | null {
        return node.parent == null ? null : doc.nodes.get(node.parent) ?? null;
      },
    };

    const entered: VisitSignal = visitor.enter ? visitor.enter(node, ctx) : undefined;
    if (entered === 'stop') {
      stopped = true;
      return;
    }
    if (entered !== 'skip') {
      for (const child of childIds(node)) {
        visit(child, depth + 1);
        if (stopped) return;
      }
    }

    const exited: VisitSignal = visitor.exit ? visitor.exit(node, ctx) : undefined;
    if (exited === 'stop') stopped = true;
  };

  visit(doc.root, 0);
}
