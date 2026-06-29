/**
 * @domflax/core — the pure applier (the one trusted mutator).
 *
 * {@link applyOps} takes an {@link IRDocument} plus a flat list of {@link RewriteOp}s and returns
 * a NEW, mutated document (the input document is left untouched — "pure" in the input-immutability
 * sense). Every op is validated against the safety ceiling and node-local safety floor before it
 * runs; rejected ops are collected into {@link ApplyResult.skipped} with {@link Diagnostic}s rather
 * than throwing. Dependency-free: only the `./types` contract and `./builders` runtime helpers.
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
  IRElement,
  IRNode,
  IRNodeId,
  NodeSpec,
  RewriteGroup,
  RewriteOp,
  SkippedOpGroup,
  StyleBlock,
  StyleDecl,
  StyleMap,
  StyleConflictPolicy,
} from './types';

import {
  BASE_CONDITION_KEY,
  createComment,
  createElement,
  createExpr,
  createFragment,
  createText,
  defaultMeta,
} from './builders';

/* ───────────────────────── result of an apply run ───────────────────────── */

export interface ApplyOutcome {
  /** The new document (the input doc is never mutated). */
  readonly doc: IRDocument;
  readonly result: ApplyResult;
}

interface MutState {
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

function cloneStyleMap(sm: StyleMap): StyleMap {
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

function diag(
  code: DiagnosticCode,
  message: string,
  extra?: Partial<Diagnostic>,
): Diagnostic {
  return { code, severity: 'warn', message, ...extra };
}

function getParentChildren(doc: IRDocument, id: IRNodeId): IRNodeId[] | null {
  const node = doc.nodes.get(id);
  if (!node || node.parent == null) return null;
  const parent = doc.nodes.get(node.parent);
  if (!parent) return null;
  if (parent.kind === 'element' || parent.kind === 'fragment') return parent.children;
  return null;
}

function indexInParent(doc: IRDocument, id: IRNodeId): number {
  const siblings = getParentChildren(doc, id);
  return siblings ? siblings.indexOf(id) : -1;
}

function markTouched(state: MutState, id: IRNodeId): void {
  const n = state.doc.nodes.get(id);
  if (n) {
    n.meta.touched = true;
    state.touched.add(id);
  }
}

function removeSubtree(state: MutState, id: IRNodeId): void {
  const node = state.doc.nodes.get(id);
  if (!node) return;
  if (node.kind === 'element' || node.kind === 'fragment') {
    for (const child of [...node.children]) removeSubtree(state, child);
  }
  state.doc.nodes.delete(id);
  state.removed.add(id);
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
function materialize(state: MutState, spec: NodeSpec, parent: IRNodeId | null): IRNodeId {
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

function elementSpecToNode(state: MutState, spec: ElementSpec, parent: IRNodeId | null): IRNodeId {
  return materialize(state, spec, parent);
}

/* ───────────────────────── style merging ───────────────────────── */

function isInherited(state: MutState, decl: StyleDecl): boolean {
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

interface MergeReport {
  readonly map: StyleMap;
  readonly conflict: boolean;
}

/** Merge `source` decls into `target`, condition-by-condition, per the conflict policy. */
function mergeStyleMaps(
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

/* ───────────────────────── per-op handlers ───────────────────────── */

function safetyOk(state: MutState, op: RewriteOp, targetId: IRNodeId): Diagnostic | null {
  const opSafety = op.origin.safety;
  if (opSafety > state.ceiling) {
    return diag(
      'DF_SAFETY_CEILING_EXCEEDED',
      `op '${op.op}' safety ${opSafety} exceeds ceiling ${state.ceiling}`,
      { nodeId: targetId, pattern: op.origin.pattern, severity: 'error' },
    );
  }
  const node = state.doc.nodes.get(targetId);
  if (node && opSafety > node.meta.safetyFloor) {
    return diag(
      'DF_SAFETY_CEILING_EXCEEDED',
      `op '${op.op}' safety ${opSafety} exceeds node ${targetId} floor ${node.meta.safetyFloor}`,
      { nodeId: targetId, pattern: op.origin.pattern, severity: 'error' },
    );
  }
  return null;
}

/** Returns a list of validation issues; empty ⇒ the op was applied. */
function applyOne(state: MutState, op: RewriteOp): Diagnostic[] {
  const { doc } = state;

  const primary = primaryTarget(op);
  if (primary != null) {
    if (!doc.nodes.get(primary)) {
      return [
        diag('DF_OP_PRECONDITION_FAILED', `target node ${primary} not found`, {
          nodeId: primary,
          pattern: op.origin.pattern,
          severity: 'error',
        }),
      ];
    }
    const safety = safetyOk(state, op, primary);
    if (safety) return [safety];
  }

  switch (op.op) {
    case 'removeNode': {
      const siblings = getParentChildren(doc, op.target);
      if (siblings) {
        const i = siblings.indexOf(op.target);
        if (i >= 0) siblings.splice(i, 1);
      }
      removeSubtree(state, op.target);
      return [];
    }

    case 'unwrap': {
      const node = doc.nodes.get(op.target);
      if (!node || (node.kind !== 'element' && node.kind !== 'fragment')) {
        return [precond(op, op.target, 'unwrap target is not a container')];
      }
      const siblings = getParentChildren(doc, op.target);
      if (!siblings) return [precond(op, op.target, 'unwrap target has no parent')];
      const at = siblings.indexOf(op.target);
      const kids = node.children;
      for (const k of kids) {
        const kn = doc.nodes.get(k);
        if (kn) kn.parent = node.parent;
      }
      siblings.splice(at, 1, ...kids);
      doc.nodes.delete(op.target);
      state.removed.add(op.target);
      if (node.parent != null) markTouched(state, node.parent);
      return [];
    }

    case 'replaceWith': {
      const siblings = getParentChildren(doc, op.target);
      if (!siblings) return [precond(op, op.target, 'replaceWith target has no parent')];
      const at = siblings.indexOf(op.target);
      const parentId = doc.nodes.get(op.target)?.parent ?? null;
      const newId = materialize(state, op.replacement, parentId);
      siblings.splice(at, 1, newId);
      removeSubtree(state, op.target);
      if (parentId != null) markTouched(state, parentId);
      return [];
    }

    case 'wrap': {
      const siblings = getParentChildren(doc, op.target);
      if (!siblings) return [precond(op, op.target, 'wrap target has no parent')];
      const at = siblings.indexOf(op.target);
      const parentId = doc.nodes.get(op.target)?.parent ?? null;
      const wrapperId = elementSpecToNode(state, op.wrapper, parentId);
      const wrapper = doc.nodes.get(wrapperId);
      const targetNode = doc.nodes.get(op.target);
      if (wrapper && (wrapper.kind === 'element' || wrapper.kind === 'fragment')) {
        wrapper.children.push(op.target);
      }
      if (targetNode) targetNode.parent = wrapperId;
      siblings.splice(at, 1, wrapperId);
      return [];
    }

    case 'insertBefore':
    case 'insertAfter': {
      const siblings = getParentChildren(doc, op.anchor);
      if (!siblings) return [precond(op, op.anchor, 'insert anchor has no parent')];
      const at = siblings.indexOf(op.anchor);
      const parentId = doc.nodes.get(op.anchor)?.parent ?? null;
      const newId = materialize(state, op.node, parentId);
      siblings.splice(op.op === 'insertBefore' ? at : at + 1, 0, newId);
      if (parentId != null) markTouched(state, parentId);
      return [];
    }

    case 'moveNode': {
      const newParent = doc.nodes.get(op.newParent);
      if (!newParent || (newParent.kind !== 'element' && newParent.kind !== 'fragment')) {
        return [precond(op, op.newParent, 'moveNode newParent is not a container')];
      }
      const siblings = getParentChildren(doc, op.target);
      if (siblings) {
        const i = siblings.indexOf(op.target);
        if (i >= 0) siblings.splice(i, 1);
      }
      const target = doc.nodes.get(op.target);
      if (target) target.parent = op.newParent;
      const idx = Math.max(0, Math.min(op.index, newParent.children.length));
      newParent.children.splice(idx, 0, op.target);
      markTouched(state, op.newParent);
      return [];
    }

    case 'mergeSiblings': {
      const first = doc.nodes.get(op.first);
      const second = doc.nodes.get(op.second);
      if (!first || !second) return [precond(op, op.first, 'mergeSiblings node missing')];
      if (
        (first.kind === 'element' || first.kind === 'fragment') &&
        (second.kind === 'element' || second.kind === 'fragment')
      ) {
        for (const c of second.children) {
          const cn = doc.nodes.get(c);
          if (cn) cn.parent = op.first;
          first.children.push(c);
        }
        second.children = [];
      }
      const siblings = getParentChildren(doc, op.second);
      if (siblings) {
        const i = siblings.indexOf(op.second);
        if (i >= 0) siblings.splice(i, 1);
      }
      doc.nodes.delete(op.second);
      state.removed.add(op.second);
      markTouched(state, op.first);
      return [];
    }

    case 'setClassList': {
      const el = doc.nodes.get(op.target);
      if (!el || el.kind !== 'element') {
        return [precond(op, op.target, 'setClassList target is not an element')];
      }
      el.computed = cloneStyleMap(op.style);
      markTouched(state, op.target);
      return [];
    }

    case 'mergeStyle': {
      const el = doc.nodes.get(op.target);
      if (!el || el.kind !== 'element') {
        return [precond(op, op.target, 'mergeStyle target is not an element')];
      }
      const report = mergeStyleMaps(el.computed, op.style, op.onConflict);
      if (report.conflict && op.onConflict === 'abort') {
        return [
          diag('DF_STYLE_CONFLICT_UNRESOLVED', `mergeStyle aborted on conflict at ${op.target}`, {
            nodeId: op.target,
            pattern: op.origin.pattern,
            severity: 'error',
          }),
        ];
      }
      el.computed = report.map;
      if (op.source != null) {
        const src = doc.nodes.get(op.source);
        if (src) markTouched(state, op.source);
      }
      markTouched(state, op.target);
      return [];
    }

    case 'foldInheritedStyles':
      return applyFold(state, op);
  }
}

function applyFold(
  state: MutState,
  op: Extract<RewriteOp, { op: 'foldInheritedStyles' }>,
): Diagnostic[] {
  const { doc } = state;
  const from = doc.nodes.get(op.from);
  if (!from || from.kind !== 'element') {
    return [precond(op, op.from, 'fold source is not an element')];
  }
  const issues: Diagnostic[] = [];
  const onlyProps: ReadonlySet<CssProperty> | null =
    op.properties === 'all-inherited' ? null : new Set(op.properties);

  const conditionKeys =
    op.conditions === 'all'
      ? [...from.computed.blocks.keys()]
      : [BASE_CONDITION_KEY];

  for (const intoId of op.into) {
    const into = doc.nodes.get(intoId);
    if (!into || into.kind !== 'element') {
      issues.push(precond(op, intoId, 'fold target is not an element'));
      continue;
    }
    // Mutable working copy; assigned back (widened) as an immutable StyleMap.
    const nextBlocks = new Map<ConditionKey, StyleBlock>(cloneStyleMap(into.computed).blocks);
    let folded = false;

    for (const key of conditionKeys) {
      const srcBlock = from.computed.blocks.get(key);
      if (!srcBlock) continue;
      const dstBlock = nextBlocks.get(key);
      const decls = dstBlock
        ? new Map<CssProperty, StyleDecl>(dstBlock.decls)
        : new Map<CssProperty, StyleDecl>();

      for (const [prop, decl] of srcBlock.decls) {
        if (onlyProps && !onlyProps.has(prop)) continue;
        if (!isInherited(state, decl)) continue;
        if (decl.relativeToParent) {
          issues.push(
            diag(
              'DF_RELATIVE_UNIT_FOLD',
              `refused to fold relative-unit declaration '${decl.property}' onto ${intoId}`,
              { nodeId: intoId, pattern: op.origin.pattern, severity: 'warn' },
            ),
          );
          continue;
        }
        if (!decls.has(prop)) {
          decls.set(prop, decl);
          folded = true;
        }
      }
      nextBlocks.set(key, { condition: srcBlock.condition, decls });
    }

    if (folded) {
      into.computed = { blocks: nextBlocks };
      markTouched(state, intoId);
    }
  }
  // Non-blocking (DF_RELATIVE_UNIT_FOLD) diagnostics are recorded but do not skip the op.
  for (const d of issues) state.diagnostics.push(d);
  return [];
}

function precond(op: RewriteOp, nodeId: IRNodeId, message: string): Diagnostic {
  return diag('DF_OP_PRECONDITION_FAILED', message, {
    nodeId,
    pattern: op.origin.pattern,
    severity: 'error',
  });
}

function primaryTarget(op: RewriteOp): IRNodeId | null {
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

/* ───────────────────────── public entry points ───────────────────────── */

/**
 * Apply a flat list of ops to a copy of `doc`. The input document is never mutated.
 * Each op is independently validated; failing ops are skipped (collected in
 * {@link ApplyResult.skipped}) instead of throwing.
 */
export function applyOps(
  doc: IRDocument,
  ops: readonly RewriteOp[],
  ctx?: Partial<ApplyContext>,
): ApplyOutcome {
  const cloned = cloneDocument(doc);
  const state: MutState = {
    doc: cloned,
    touched: new Set(),
    removed: new Set(),
    created: new Set(),
    diagnostics: [],
    skipped: [],
    appliedGroups: 0,
    ceiling: ctx?.safetyCeiling ?? 3,
    ctx: { doc: cloned, safetyCeiling: ctx?.safetyCeiling ?? 3, ...ctx } as ApplyContext,
  };

  for (const op of ops) {
    const issues = applyOne(state, op);
    if (issues.length > 0) {
      state.skipped.push({
        group: { pattern: op.origin.pattern, anchor: primaryTarget(op) ?? doc.root, ops: [op] },
        issues: issues.map((d) => ({ op, code: d.code, message: d.message })),
      });
      for (const d of issues) state.diagnostics.push(d);
    } else {
      state.appliedGroups += 1;
    }
  }

  return { doc: cloned, result: finalize(state) };
}

/**
 * Apply pre-grouped ops (each {@link RewriteGroup} is committed atomically: if ANY op in the group
 * fails validation, the whole group is skipped and none of its ops mutate the tree).
 */
export function applyGroups(
  doc: IRDocument,
  groups: readonly RewriteGroup[],
  ctx?: Partial<ApplyContext>,
): ApplyOutcome {
  // Group-atomicity is realized by working on a throwaway clone per group, then committing.
  let current = cloneDocument(doc);
  const touched = new Set<IRNodeId>();
  const removed = new Set<IRNodeId>();
  const created = new Set<IRNodeId>();
  const diagnostics: Diagnostic[] = [];
  const skipped: SkippedOpGroup[] = [];
  let appliedGroups = 0;

  for (const group of groups) {
    const attempt = applyOps(current, group.ops, ctx);
    if (attempt.result.skipped.length > 0) {
      skipped.push({
        group,
        issues: attempt.result.skipped.flatMap((s) => s.issues),
      });
      for (const s of attempt.result.skipped) for (const i of s.issues) {
        diagnostics.push(diag(i.code, i.message, { pattern: group.pattern }));
      }
      continue; // discard the attempt — group is atomic
    }
    current = attempt.doc;
    appliedGroups += 1;
    for (const id of attempt.result.touched) touched.add(id);
    for (const id of attempt.result.removed) removed.add(id);
    for (const id of attempt.result.created) created.add(id);
    for (const d of attempt.result.diagnostics) diagnostics.push(d);
  }

  const result: ApplyResult = {
    touched,
    removed,
    created,
    appliedGroups,
    skipped,
    journal: [],
    diagnostics,
  };
  return { doc: current, result };
}

function finalize(state: MutState): ApplyResult {
  return {
    touched: state.touched,
    removed: state.removed,
    created: state.created,
    appliedGroups: state.appliedGroups,
    skipped: state.skipped,
    journal: [],
    diagnostics: state.diagnostics,
  };
}
