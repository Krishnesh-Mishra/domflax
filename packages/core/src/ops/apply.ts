/**
 * @domflax/core — the per-op handlers + public apply entry points.
 *
 * {@link applyOps} validates each {@link RewriteOp} against the safety ceiling / node-local floor
 * and commits it to a clone of the document; {@link applyGroups} commits whole {@link RewriteGroup}s
 * atomically. Rejected ops are collected into {@link ApplyResult.skipped} rather than throwing.
 */

import type {
  ApplyContext,
  ApplyResult,
  ConditionKey,
  CssProperty,
  Diagnostic,
  IRDocument,
  IRNodeId,
  RewriteGroup,
  RewriteOp,
  SkippedOpGroup,
  StyleBlock,
  StyleDecl,
} from '../types';

import { BASE_CONDITION_KEY } from '../builders';

import {
  cloneDocument,
  cloneStyleMap,
  diag,
  elementSpecToNode,
  getParentChildren,
  isInherited,
  markTouched,
  materialize,
  mergeStyleMaps,
  precond,
  primaryTarget,
  removeSubtree,
  type ApplyOutcome,
  type MutState,
} from './runtime';

export type { ApplyOutcome } from './runtime';
export { cloneDocument } from './runtime';

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
