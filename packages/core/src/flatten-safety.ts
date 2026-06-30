/**
 * @domflax/core — static classification of a flatten (the VERIFIER-GATED safety core).
 *
 * A flatten pattern matches on `paintsNothing` + a structural/style signature, but unwrapping a
 * wrapper can still change rendering: a wrapper with non-paint layout styles (e.g. `px-4 py-4`) drops
 * that padding when removed (it is NOT reproduced on the surviving child), and a centering wrapper
 * collapsed to `place-self:center` only stays centered when the child's NEW parent is flex/grid. The
 * existing emittability revert only checks the ADDED style is re-emittable — not that the wrapper's
 * own styles survive, nor that the parent context holds.
 *
 * {@link classifyFlattenOps} answers, for one applied flatten op-group, whether it is:
 *
 *   • `'provably-safe'`       — removing the wrapper changes NOTHING renderable: the wrapper
 *                                establishes no box/formatting/stacking context, has no non-inherited
 *                                own declaration that the rewrite does not reproduce on the surviving
 *                                child, AND the rewrite adds no parent-context-dependent self-alignment
 *                                (unless the new parent is statically flex/grid). Examples: passthrough
 *                                / empty-style / display-contents / redundant-fragment wrappers.
 *   • `'needs-verification'`  — anything else (drops/relies on a style, or centering→place-self).
 *
 * Pure + dependency-free: only the `./types` contract + `./builders` accessors.
 */

import { conditionKey, getElement } from './builders';
import type {
  CssProperty,
  IRDocument,
  IRElement,
  IRNodeId,
  RewriteOp,
  StyleDecl,
  StyleMap,
  StyleNormalizer,
} from './types';

/** The static verdict for one flatten op-group. */
export type FlattenClass = 'provably-safe' | 'needs-verification';

/** A classified flatten plus the structural anchors a verifier needs to render before/after. */
export interface FlattenClassification {
  readonly kind: FlattenClass;
  /** The unwrapped wrapper (in the BEFORE doc), or null when the group removes no element box. */
  readonly wrapperId: IRNodeId | null;
  /** The surviving child styles fold onto (the AFTER subtree root), or null. */
  readonly childId: IRNodeId | null;
}

/* ───────────────────────── display / context reasoning ───────────────────────── */

const DISPLAY = 'display' as CssProperty;
const POSITION = 'position' as CssProperty;
const TRANSFORM = 'transform' as CssProperty;

/** Displays that generate no independent formatting context for the wrapper's children. */
const CONTEXT_SAFE_DISPLAYS: ReadonlySet<string> = new Set(['block', 'contents', '']);
/** `position` values that neither establish a containing block nor offset the element. */
const STATIC_POSITIONS: ReadonlySet<string> = new Set(['static', '']);

/** Self-alignment properties whose effect depends on the parent being a flex/grid container. */
const SELF_ALIGN_PROPS: readonly CssProperty[] = [
  'place-self' as CssProperty,
  'align-self' as CssProperty,
  'justify-self' as CssProperty,
];
/** Self-alignment values that are no-ops (so adding them assumes nothing about the parent). */
const NEUTRAL_ALIGN: ReadonlySet<string> = new Set(['auto', 'normal', 'auto auto', '']);
/** Parent displays under which `place-self`/`*-self` centering actually takes effect. */
const FLEX_GRID_DISPLAYS: ReadonlySet<string> = new Set(['flex', 'inline-flex', 'grid', 'inline-grid']);

/**
 * True when the wrapper establishes a box/formatting/stacking context that positions or sizes its
 * children — so removing its box could move/resize the surviving child. Derived from the COMPUTED
 * style (the frontend leaves the `meta.establishes*` flags unset for class-resolved styles), exactly
 * how `hasOwnVisualStyle` reasons over the computed map.
 */
function establishesChildContext(sm: StyleMap): boolean {
  for (const block of sm.blocks.values()) {
    const display = block.decls.get(DISPLAY);
    if (display && !CONTEXT_SAFE_DISPLAYS.has(String(display.value))) return true;
    const position = block.decls.get(POSITION);
    if (position && !STATIC_POSITIONS.has(String(position.value))) return true;
    const transform = block.decls.get(TRANSFORM);
    if (transform && String(transform.value) !== 'none') return true;
  }
  return false;
}

/* ───────────────────────── declaration reasoning ───────────────────────── */

function isInherited(decl: StyleDecl, norm: StyleNormalizer): boolean {
  if (decl.inherited) return true;
  try {
    return norm.inherited.isInherited(decl.property);
  } catch {
    return false;
  }
}

/** True when the child reproduces this exact declaration (same property + value) in the same condition. */
function childReproduces(
  childComputed: StyleMap | null,
  conditionK: string,
  prop: CssProperty,
  value: string,
): boolean {
  if (!childComputed) return false;
  const block = childComputed.blocks.get(conditionK as never);
  if (!block) return false;
  const d = block.decls.get(prop);
  return d != null && String(d.value) === value;
}

/**
 * True when the wrapper carries a non-inherited declaration that is NOT reproduced on the surviving
 * child — i.e. flattening would DROP a renderable style. `display`/`position`/`transform` are skipped
 * because {@link establishesChildContext} already governs them (and when it passed they are no-ops).
 */
function dropsOwnStyle(
  wrapperComputed: StyleMap,
  childComputed: StyleMap | null,
  norm: StyleNormalizer,
): boolean {
  for (const block of wrapperComputed.blocks.values()) {
    const ck = conditionKey(block.condition);
    for (const [prop, decl] of block.decls) {
      if (prop === DISPLAY || prop === POSITION || prop === TRANSFORM) continue;
      if (isInherited(decl, norm)) continue; // folded onto the child by foldInheritedStyles
      if (!childReproduces(childComputed, ck, prop, String(decl.value))) return true;
    }
  }
  return false;
}

/* ───────────────────────── parent-context reasoning ───────────────────────── */

/** The element's base-condition `display` value (normalized), or '' when unset/not an element. */
function displayOf(el: IRElement | undefined, norm: StyleNormalizer): string {
  if (!el) return '';
  for (const block of norm.normalizeStyleMap(el.computed).blocks.values()) {
    if (block.condition.media === '' && block.condition.states.length === 0 && block.condition.pseudoElement === '') {
      const d = block.decls.get(DISPLAY);
      if (d) return String(d.value);
    }
  }
  return '';
}

/** True when unwrapping `wrapper` reparents the child UNDER a flex/grid container in the before-tree. */
function newParentIsFlexOrGrid(before: IRDocument, wrapper: IRElement, norm: StyleNormalizer): boolean {
  if (wrapper.parent == null) return false;
  const p = before.nodes.get(wrapper.parent);
  if (!p || p.kind !== 'element') return false;
  return FLEX_GRID_DISPLAYS.has(displayOf(p, norm));
}

/**
 * True when the rewrite GRANTS the child a parent-context-dependent self-alignment (place-self /
 * align-self / justify-self with a non-neutral value) that was not already on it — centering that only
 * holds if the new parent is flex/grid.
 */
function addsParentContextStyle(
  childBefore: StyleMap | null,
  childAfter: StyleMap | null,
  norm: StyleNormalizer,
): boolean {
  if (!childAfter) return false;
  const before = childBefore ? norm.normalizeStyleMap(childBefore) : null;
  const after = norm.normalizeStyleMap(childAfter);
  for (const block of after.blocks.values()) {
    const ck = conditionKey(block.condition);
    for (const prop of SELF_ALIGN_PROPS) {
      const d = block.decls.get(prop);
      if (!d || NEUTRAL_ALIGN.has(String(d.value))) continue;
      const prev = before?.blocks.get(ck as never)?.decls.get(prop);
      if (!prev || String(prev.value) !== String(d.value)) return true;
    }
  }
  return false;
}

/* ───────────────────────── op-group anchors ───────────────────────── */

/** The wrapper the group unwraps (the structural removal), or null when the group removes no box. */
function unwrapTargetOf(ops: readonly RewriteOp[]): IRNodeId | null {
  for (const op of ops) if (op.op === 'unwrap') return op.target;
  return null;
}

/** The surviving child styles fold onto: the mergeStyle/fold target, else the wrapper's sole element child. */
function survivingChildOf(ops: readonly RewriteOp[], wrapper: IRElement, before: IRDocument): IRNodeId | null {
  for (const op of ops) if (op.op === 'mergeStyle') return op.target;
  for (const op of ops) if (op.op === 'foldInheritedStyles' && op.into.length > 0) return op.into[0]!;
  for (const c of wrapper.children) {
    const n = before.nodes.get(c);
    if (n && n.kind === 'element') return c;
  }
  return null;
}

/* ───────────────────────── the classifier ───────────────────────── */

/**
 * Statically classify one applied flatten op-group. `before` is the doc as it was BEFORE the group's
 * ops; `after` is the result of applying them.
 *
 * A group that unwraps no element box (e.g. {@link redundant-fragment}, or a style-only flatten) is
 * `provably-safe` — there is no box whose removal could move/resize anything. Otherwise the three
 * criteria above decide.
 */
export function classifyFlattenOps(
  before: IRDocument,
  after: IRDocument,
  ops: readonly RewriteOp[],
  norm: StyleNormalizer,
): FlattenClassification {
  const wrapperId = unwrapTargetOf(ops);
  if (wrapperId == null) return { kind: 'provably-safe', wrapperId: null, childId: null };

  const wrapper = before.nodes.get(wrapperId);
  // A fragment carries no box and no computed style — unwrapping it is always layout-identical.
  if (!wrapper || wrapper.kind !== 'element') {
    return { kind: 'provably-safe', wrapperId: null, childId: null };
  }

  const childId = survivingChildOf(ops, wrapper, before);
  const wrapperComputed = norm.normalizeStyleMap(wrapper.computed);
  const childAfter = childId != null ? getElement(after, childId)?.computed ?? null : null;
  const childBefore = childId != null ? getElement(before, childId)?.computed ?? null : null;

  // (A) wrapper positions/sizes its children → removing its box can move/resize them.
  if (establishesChildContext(wrapperComputed)) {
    return { kind: 'needs-verification', wrapperId, childId };
  }
  // (B) wrapper drops a non-inherited own style the child does not reproduce.
  if (dropsOwnStyle(wrapperComputed, childAfter ? norm.normalizeStyleMap(childAfter) : null, norm)) {
    return { kind: 'needs-verification', wrapperId, childId };
  }
  // (C) rewrite adds parent-context-dependent centering, but the new parent is not statically flex/grid.
  if (addsParentContextStyle(childBefore, childAfter, norm) && !newParentIsFlexOrGrid(before, wrapper, norm)) {
    return { kind: 'needs-verification', wrapperId, childId };
  }

  return { kind: 'provably-safe', wrapperId, childId };
}
