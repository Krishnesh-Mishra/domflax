/**
 * @domflax/core — applier runtime helpers (shared by the per-op handlers in `./apply`).
 *
 * Pure, dependency-free building blocks for the trusted mutator: input-preserving cloning, the
 * mutable apply state, small tree helpers, detached-spec materialization, and style merging.
 * Only depends on the `../types` contract and `../builders` runtime helpers.
 */

import type {
  ApplyContext,
  ApplyResult,
  AttrMap,
  AttrValue,
  ConditionKey,
  CssProperty,
  Diagnostic,
  DiagnosticCode,
  ElementSpec,
  IRDocument,
  IRNode,
  IRNodeId,
  NodeSpec,
  RewriteOp,
  SkippedOpGroup,
  StyleBlock,
  StyleConflictPolicy,
  StyleDecl,
  StyleMap,
} from '../types';

import {
  createComment,
  createElement,
  createExpr,
  createFragment,
  createText,
  defaultMeta,
} from '../builders';

/* ───────────────────────── result of an apply run ───────────────────────── */

export interface ApplyOutcome {
  /** The new document (the input doc is never mutated). */
  readonly doc: IRDocument;
  readonly result: ApplyResult;
}

export interface MutState {
  readonly doc: IRDocument;
  readonly touched: Set<IRNodeId>;
  readonly removed: Set<IRNodeId>;
  readonly created: Set<IRNodeId>;
  readonly diagnostics: Diagnostic[];
  readonly skipped: SkippedOpGroup[];
  appliedGroups: number;
  readonly ceiling: number;
  readonly ctx: ApplyContext;
}

/* ───────────────────────── cloning (keep input pure) ───────────────────────── */

export function cloneStyleMap(sm: StyleMap): StyleMap {
  const blocks = new Map<ConditionKey, StyleBlock>();
  for (const [key, block] of sm.blocks) {
    blocks.set(key, {
      condition: block.condition,
      decls: new Map<CssProperty, StyleDecl>(block.decls),
    });
  }
  return { blocks };
}

function cloneNode(node: IRNode): IRNode {
  const meta = { ...node.meta };
  switch (node.kind) {
    case 'element':
      return {
        ...node,
        meta,
        children: [...node.children],
        computed: cloneStyleMap(node.computed),
      };
    case 'fragment':
      return { ...node, meta, children: [...node.children] };
    default:
      return { ...node, meta };
  }
}

/** Shallow-immutable clone: input doc and its node objects are never mutated. */
export function cloneDocument(doc: IRDocument): IRDocument {
  const nodes = new Map<IRNodeId, IRNode>();
  for (const [id, n] of doc.nodes) nodes.set(id, cloneNode(n));
  return {
    root: doc.root,
    nodes,
    exprs: doc.exprs,
    sources: doc.sources,
    backref: doc.backref,
    frontend: doc.frontend,
    alloc: doc.alloc,
  };
}

/* ───────────────────────── small helpers ───────────────────────── */

export function diag(
  code: DiagnosticCode,
  message: string,
  extra?: Partial<Diagnostic>,
): Diagnostic {
  return { code, severity: 'warn', message, ...extra };
}

export function getParentChildren(doc: IRDocument, id: IRNodeId): IRNodeId[] | null {
  const node = doc.nodes.get(id);
  if (!node || node.parent == null) return null;
  const parent = doc.nodes.get(node.parent);
  if (!parent) return null;
  if (parent.kind === 'element' || parent.kind === 'fragment') return parent.children;
  return null;
}

export function indexInParent(doc: IRDocument, id: IRNodeId): number {
  const siblings = getParentChildren(doc, id);
  return siblings ? siblings.indexOf(id) : -1;
}

export function markTouched(state: MutState, id: IRNodeId): void {
  const n = state.doc.nodes.get(id);
  if (n) {
    n.meta.touched = true;
    state.touched.add(id);
  }
}

export function removeSubtree(state: MutState, id: IRNodeId): void {
  const node = state.doc.nodes.get(id);
  if (!node) return;
  if (node.kind === 'element' || node.kind === 'fragment') {
    for (const child of [...node.children]) removeSubtree(state, child);
  }
  state.doc.nodes.delete(id);
  state.removed.add(id);
}

export function precond(op: RewriteOp, nodeId: IRNodeId, message: string): Diagnostic {
  return diag('DF_OP_PRECONDITION_FAILED', message, {
    nodeId,
    pattern: op.origin.pattern,
    severity: 'error',
  });
}

export function primaryTarget(op: RewriteOp): IRNodeId | null {
  switch (op.op) {
    case 'removeNode':
    case 'unwrap':
    case 'replaceWith':
    case 'wrap':
    case 'moveNode':
    case 'setClassList':
    case 'mergeStyle':
      return op.target;
    case 'insertBefore':
    case 'insertAfter':
      return op.anchor;
    case 'mergeSiblings':
      return op.first;
    case 'foldInheritedStyles':
      return op.from;
  }
}

/* ───────────────────────── spec materialization ───────────────────────── */

function specToAttrs(map: ReadonlyMap<string, string | boolean> | undefined): AttrMap {
  if (!map || map.size === 0) return { entries: new Map(), spreads: [], order: [] };
  const entries = new Map<string, AttrValue>();
  const order: string[] = [];
  for (const [k, v] of map) {
    entries.set(k, { kind: 'static', value: v });
    order.push(k);
  }
  return { entries, spreads: [], order };
}

/** Materialize a detached {@link NodeSpec} into live nodes; returns the new (or reused) id. */
export function materialize(state: MutState, spec: NodeSpec, parent: IRNodeId | null): IRNodeId {
  const { doc } = state;
  if (spec.kind === 'ref') {
    const existing = doc.nodes.get(spec.ref);
    if (existing) existing.parent = parent;
    return spec.ref;
  }

  const id = doc.alloc.next();
  state.created.add(id);
  switch (spec.kind) {
    case 'element': {
      const childIds: IRNodeId[] = [];
      const el = createElement(id, {
        tag: spec.tag,
        namespace: spec.namespace,
        selfClosing: spec.selfClosing,
        attrs: specToAttrs(spec.attrs),
        parent,
        meta: { ...defaultMeta(), synthetic: true },
      });
      if (spec.classes) el.computed = cloneStyleMap(spec.classes);
      doc.nodes.set(id, el);
      for (const child of spec.children ?? []) {
        childIds.push(materialize(state, child, id));
      }
      el.children = childIds;
      return id;
    }
    case 'text': {
      const t = createText(id, spec.value, { parent });
      t.meta.synthetic = true;
      doc.nodes.set(id, t);
      return id;
    }
    case 'expr': {
      const e = createExpr(id, spec.expr, { parent });
      e.meta.synthetic = true;
      doc.nodes.set(id, e);
      return id;
    }
    case 'comment': {
      const c = createComment(id, spec.value, { parent });
      c.meta.synthetic = true;
      doc.nodes.set(id, c);
      return id;
    }
    case 'fragment': {
      const frag = createFragment(id, { parent });
      frag.meta.synthetic = true;
      doc.nodes.set(id, frag);
      const childIds: IRNodeId[] = [];
      for (const child of spec.children) childIds.push(materialize(state, child, id));
      frag.children = childIds;
      return id;
    }
  }
}

export function elementSpecToNode(
  state: MutState,
  spec: ElementSpec,
  parent: IRNodeId | null,
): IRNodeId {
  return materialize(state, spec, parent);
}

/* ───────────────────────── style merging ───────────────────────── */

export function isInherited(state: MutState, decl: StyleDecl): boolean {
  if (decl.inherited) return true;
  const table = state.ctx.normalizer?.inherited;
  if (table) {
    try {
      return table.isInherited(decl.property);
    } catch {
      return decl.inherited;
    }
  }
  return decl.inherited;
}

export interface MergeReport {
  readonly map: StyleMap;
  readonly conflict: boolean;
}

/** Merge `source` decls into `target`, condition-by-condition, per the conflict policy. */
export function mergeStyleMaps(
  target: StyleMap,
  source: StyleMap,
  policy: StyleConflictPolicy,
): MergeReport {
  // Mutable working copy; returned (widened) as an immutable StyleMap.
  const blocks = new Map<ConditionKey, StyleBlock>(cloneStyleMap(target).blocks);
  let conflict = false;

  for (const [key, srcBlock] of source.blocks) {
    const existing = blocks.get(key);
    if (!existing) {
      blocks.set(key, {
        condition: srcBlock.condition,
        decls: new Map<CssProperty, StyleDecl>(srcBlock.decls),
      });
      continue;
    }
    const decls = new Map<CssProperty, StyleDecl>(existing.decls);
    for (const [prop, srcDecl] of srcBlock.decls) {
      const had = decls.get(prop);
      if (had && had.value !== srcDecl.value) {
        conflict = true;
        if (policy === 'target-wins') continue;
        // 'abort' is handled by the caller before commit; 'source-wins' falls through.
      }
      if (policy === 'target-wins' && had) continue;
      decls.set(prop, srcDecl);
    }
    blocks.set(key, { condition: existing.condition, decls });
  }
  return { map: { blocks }, conflict };
}
