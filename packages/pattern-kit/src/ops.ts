/**
 * @domflax/pattern-kit — ergonomic op-draft constructors.
 *
 * Thin, pure helpers that build the core {@link RewriteOpDraft} objects so pattern authors can
 * assemble a `MatchResult.ops` array without hand-writing discriminant literals. Drafts carry NO
 * `origin` — the pass-manager stamps `{ pattern, category, safety }` when it schedules the op
 * (see core's `stampOrigin`). Each helper accepts a live node, a DeepReadonly view, or a bare
 * {@link IRNodeId}.
 *
 * Mirrors the four ops a rewrite typically reaches for: `mergeStyle`, `foldInheritedStyles`,
 * `replaceWith`, `removeNode`.
 */

import type {
  CssProperty,
  ElementLike,
  IRNode,
  IRNodeId,
  NodeLike,
  NodeSpec,
  RewriteOpDraft,
  StyleConflictPolicy,
  StyleMap,
} from '@domflax/core';

/** Accept a live/readonly node or a bare id. */
type Ref = NodeLike | ElementLike | IRNodeId;

function idOf(ref: Ref): IRNodeId {
  return typeof ref === 'number' ? (ref as IRNodeId) : ((ref as IRNode).id as IRNodeId);
}

/* ───────────────────────── style ops ───────────────────────── */

/**
 * Merge `style` onto `target`, optionally pulling from `source` (or `null` for a literal patch).
 * `onConflict` defaults to `'abort'` — the safest policy (the applier refuses rather than guess).
 */
export function mergeStyle(
  target: Ref,
  source: Ref | null,
  style: StyleMap,
  onConflict: StyleConflictPolicy = 'abort',
): RewriteOpDraft {
  return {
    op: 'mergeStyle',
    target: idOf(target),
    source: source == null ? null : idOf(source),
    style,
    onConflict,
  };
}

/**
 * Fold inheritable declarations from `from` down into one or more descendants. `conditions:'all'`
 * folds across every StyleCondition (states/media/pseudo-elements); the default `'base'` folds only
 * the unconditional block. `only` restricts the property set (otherwise `'all-inherited'`).
 */
export function foldInheritedStyles(
  from: Ref,
  into: Ref | readonly Ref[],
  opts?: { only?: readonly CssProperty[]; conditions?: 'base' | 'all' },
): RewriteOpDraft {
  const list: readonly Ref[] = Array.isArray(into) ? (into as readonly Ref[]) : [into as Ref];
  return {
    op: 'foldInheritedStyles',
    from: idOf(from),
    into: list.map(idOf),
    properties: opts?.only ?? 'all-inherited',
    conditions: opts?.conditions ?? 'base',
  };
}

/* ───────────────────────── structural ops ───────────────────────── */

/** Replace `target` with a detached {@link NodeSpec} (the applier materializes ids on apply). */
export function replaceWith(target: Ref, replacement: NodeSpec): RewriteOpDraft {
  return { op: 'replaceWith', target: idOf(target), replacement };
}

/** Remove `target` (and its subtree) from the tree. */
export function removeNode(target: Ref): RewriteOpDraft {
  return { op: 'removeNode', target: idOf(target) };
}
