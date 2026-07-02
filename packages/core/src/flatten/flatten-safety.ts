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

import { conditionKey, getElement } from '../ir/builders';
import type {
  CssProperty,
  IRDocument,
  IRElement,
  IRNodeId,
  RewriteOp,
  StyleBlock,
  StyleDecl,
  StyleMap,
  StyleNormalizer,
} from '../ir/types';

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
const ALIGN_ITEMS = 'align-items' as CssProperty;
const JUSTIFY_CONTENT = 'justify-content' as CssProperty;
const JUSTIFY_ITEMS = 'justify-items' as CssProperty;
const PLACE_ITEMS = 'place-items' as CssProperty;
const PLACE_SELF = 'place-self' as CssProperty;

/** Displays that generate no independent formatting context for the wrapper's children. */
const CONTEXT_SAFE_DISPLAYS: ReadonlySet<string> = new Set(['block', 'contents', '']);
/** `position` values that neither establish a containing block nor offset the element. */
const STATIC_POSITIONS: ReadonlySet<string> = new Set(['static', '']);

/* ───────────────────────── context-compensated centering (grid-parent override) ───────────────────────── */

/**
 * Displays under which a block-level wrapper carrying `align-items:center` + `justify-content:center`
 * truly centers a single child on BOTH axes (so collapsing it to `place-self:center` is lossless).
 * Restricted to the block-level `flex`/`grid` (per the CSS soundness rule) — the inline variants are
 * left `needs-verification`.
 */
const CENTERING_DISPLAYS: ReadonlySet<string> = new Set(['flex', 'grid']);
/**
 * Parent displays that establish a GRID formatting context — the ONLY context in which the child's
 * `justify-self` (the horizontal half of `place-self:center`) is honored. A flex parent ignores
 * `justify-self`, and a block parent ignores both, so neither can host the flatten.
 */
const GRID_PARENT_DISPLAYS: ReadonlySet<string> = new Set(['grid']);
/**
 * Item-alignment values under which a stretch-defaulted grid item FILLS its area. Only when the
 * wrapper fills its grid area does "center inside the wrapper" equal "center inside the area" (which
 * is what `place-self:center` on the child produces). Any other value (start/end/center/…) would let
 * the wrapper shrink and sit off-center, so the collapse could move the child → we preserve.
 */
const STRETCHY_ITEM_ALIGN: ReadonlySet<string> = new Set(['normal', 'stretch']);
/** Parent item-alignment properties that, when non-stretch, stop the wrapper filling its grid area. */
const PARENT_ITEMS_ALIGN_PROPS: readonly CssProperty[] = [ALIGN_ITEMS, JUSTIFY_ITEMS, PLACE_ITEMS];

/** True when a style condition is the unconditional base (no media / states / pseudo-element). */
function isBaseCondition(block: StyleBlock): boolean {
  const c = block.condition;
  return c.media === '' && c.states.length === 0 && c.pseudoElement === '';
}

/** The base-condition value of `prop` in a NORMALIZED style map, or null when unset. */
function baseValue(sm: StyleMap, prop: CssProperty): string | null {
  for (const block of sm.blocks.values()) {
    if (!isBaseCondition(block)) continue;
    const d = block.decls.get(prop);
    return d ? String(d.value) : null;
  }
  return null;
}

/**
 * True when unwrapping `wrapper` reparents the child under a statically-known GRID container that lets
 * the wrapper fill its area — the ONE parent context in which `place-self:center` reproduces the
 * wrapper's centering exactly. Requires (a) the parent is `display:grid`/`inline-grid` in the base
 * condition, (b) NO condition switches the parent to a non-grid display, and (c) NO condition forces a
 * non-stretch item-alignment (align-items/justify-items/place-items) that would shrink the wrapper off
 * its area. Anything else (flex/block/unknown parent, `place-items:center`, responsive `md:flex`, …)
 * → false → the flatten stays `needs-verification` (preserved).
 */
function parentIsFillingGrid(before: IRDocument, wrapper: IRElement, norm: StyleNormalizer): boolean {
  if (wrapper.parent == null) return false;
  const p = before.nodes.get(wrapper.parent);
  if (!p || p.kind !== 'element') return false;
  const pc = norm.normalizeStyleMap(p.computed);
  let baseIsGrid = false;
  for (const block of pc.blocks.values()) {
    const disp = block.decls.get(DISPLAY);
    if (disp) {
      if (!GRID_PARENT_DISPLAYS.has(String(disp.value))) return false; // any non-grid display → unsafe
      if (isBaseCondition(block)) baseIsGrid = true;
    }
    for (const prop of PARENT_ITEMS_ALIGN_PROPS) {
      const d = block.decls.get(prop);
      if (d && !STRETCHY_ITEM_ALIGN.has(String(d.value))) return false; // wrapper would not fill its area
    }
  }
  return baseIsGrid;
}

/**
 * True when the wrapper carries NOTHING beyond the base-condition centering signature
 * (`display:flex|grid` + `align-items:center` + `justify-content:center`) that removal would drop.
 * Those three are compensated by the child's new `place-self:center`; `position:static`/`transform:none`
 * are inert; inherited declarations are folded onto the child by `foldInheritedStyles`; and any decl the
 * child provably reproduces is not lost. ANY other non-inherited own declaration — in any condition
 * (padding, margin, sizing, border, background, gap, a NON-base or NON-center align-items/justify-content,
 * a non-static position, a transform, …) → false → not a pure centering wrapper → preserved.
 */
function wrapperHasOnlyCenteringStyle(
  wrapperComputed: StyleMap,
  childComputed: StyleMap | null,
  norm: StyleNormalizer,
): boolean {
  for (const block of wrapperComputed.blocks.values()) {
    const base = isBaseCondition(block);
    const ck = conditionKey(block.condition);
    for (const [prop, decl] of block.decls) {
      const val = String(decl.value);
      if (prop === DISPLAY) {
        if (base && CENTERING_DISPLAYS.has(val)) continue;
        return false;
      }
      if (prop === ALIGN_ITEMS) {
        if (base && val === 'center') continue;
        return false;
      }
      if (prop === JUSTIFY_CONTENT) {
        if (base && val === 'center') continue;
        return false;
      }
      if (prop === POSITION) {
        if (STATIC_POSITIONS.has(val)) continue;
        return false;
      }
      if (prop === TRANSFORM) {
        if (val === 'none') continue;
        return false;
      }
      if (isInherited(decl, norm)) continue; // folded onto the child by foldInheritedStyles
      if (childReproduces(childComputed, ck, prop, val)) continue;
      return false; // some other own style would be dropped
    }
  }
  return true;
}

/** True when `wrapper` has exactly ONE element child and no other RENDERED content (rule 4). */
function wrapperCentersSingleElement(before: IRDocument, wrapper: IRElement): boolean {
  let elements = 0;
  for (const cid of wrapper.children) {
    const n = before.nodes.get(cid);
    if (!n) continue;
    if (n.kind === 'element') {
      elements += 1;
      continue;
    }
    if (n.kind === 'comment') continue; // comments paint nothing and are not flex/grid items
    if (n.kind === 'text' && n.value.trim() === '') continue; // collapsible whitespace ⇒ no item
    return false; // real text / an `{expr}` island the wrapper's centering also positions
  }
  return elements === 1;
}

/** True when the child ALREADY carries a non-neutral self-alignment that place-self:center would override (rule 5). */
function childHasSelfAlign(childBefore: StyleMap | null, norm: StyleNormalizer): boolean {
  if (!childBefore) return false;
  const sm = norm.normalizeStyleMap(childBefore);
  for (const block of sm.blocks.values()) {
    for (const prop of SELF_ALIGN_PROPS) {
      const d = block.decls.get(prop);
      if (d && !NEUTRAL_ALIGN.has(String(d.value))) return true;
    }
  }
  return false;
}

/** True when the rewrite grants the child the `place-self:center` equivalent (rule 2, second half). */
function childGainsPlaceSelfCenter(childAfter: StyleMap): boolean {
  if (baseValue(childAfter, PLACE_SELF) === 'center') return true;
  return (
    baseValue(childAfter, 'align-self' as CssProperty) === 'center' &&
    baseValue(childAfter, 'justify-self' as CssProperty) === 'center'
  );
}

/**
 * The provably-sound override for the ubiquitous centering wrapper. Flattening
 *
 *   <P grid><W flex/grid items-center justify-center><C/></W></P>  →  <P grid><C place-self:center/></P>
 *
 * is render-identical ONLY when ALL hold (each proven statically from the before-tree):
 *   1. Parent P establishes a GRID formatting context that lets the wrapper fill its area — so the
 *      child's new `justify-self:center` (ignored under flex/block) is honored. ({@link parentIsFillingGrid})
 *   2. Wrapper W centers a single child on both axes (`display:flex|grid` + `align-items:center` +
 *      `justify-content:center`) and the child gains the equivalent `place-self:center`.
 *   3. W has no OTHER non-inherited box style whose removal would drop or shift anything.
 *      ({@link wrapperHasOnlyCenteringStyle})
 *   4. W has exactly one ELEMENT child and no other rendered content. ({@link wrapperCentersSingleElement})
 *   5. C does not already carry a conflicting `place-self`/`align-self`/`justify-self`. ({@link childHasSelfAlign})
 *
 * Any failure → false → the wrapper is preserved (the conservative default). Works identically for the
 * HTML and JSX pipelines: the parent display is read from the before-tree's resolved computed styles.
 */
function isContextCompensatedCentering(
  before: IRDocument,
  wrapper: IRElement,
  wrapperComputed: StyleMap,
  childBefore: StyleMap | null,
  childAfter: StyleMap | null,
  norm: StyleNormalizer,
): boolean {
  if (!childAfter) return false;
  // (2) wrapper centering signature (base condition) + the child actually gains place-self:center.
  if (!CENTERING_DISPLAYS.has(baseValue(wrapperComputed, DISPLAY) ?? '')) return false;
  if (baseValue(wrapperComputed, ALIGN_ITEMS) !== 'center') return false;
  if (baseValue(wrapperComputed, JUSTIFY_CONTENT) !== 'center') return false;
  const childAfterNorm = norm.normalizeStyleMap(childAfter);
  if (!childGainsPlaceSelfCenter(childAfterNorm)) return false;
  // (3) nothing else on the wrapper is dropped.
  if (!wrapperHasOnlyCenteringStyle(wrapperComputed, childAfterNorm, norm)) return false;
  // (4) exactly one element child, nothing else the wrapper positions.
  if (!wrapperCentersSingleElement(before, wrapper)) return false;
  // (5) the child has no pre-existing self-alignment place-self:center would override.
  if (childHasSelfAlign(childBefore, norm)) return false;
  // (1) the new parent is a statically-known grid that lets the wrapper fill its area.
  return parentIsFillingGrid(before, wrapper, norm);
}

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

  // SAFETY (Layer 2, backstop): if ANY of the wrapper's own class tokens was UNRESOLVED, its true
  // style is UNKNOWN — `wrapper.computed` is only the resolved subset, so the static "inert" reasoning
  // below (which sees an empty/partial map) could wrongly clear it. Never treat such a wrapper as
  // provably safe to unwrap. Under the default `'provably-safe'` gate this reverts (preserves) the
  // flatten; the match-time `hasOwnVisualStyle` gate already blocks the paintsNothing patterns, so this
  // catches a positive-computed flatten (e.g. nested-flex-merge) that also carries an unknown token.
  if (wrapper.meta.hasUnresolvedClasses) {
    return { kind: 'needs-verification', wrapperId, childId: survivingChildOf(ops, wrapper, before) };
  }

  const childId = survivingChildOf(ops, wrapper, before);
  const wrapperComputed = norm.normalizeStyleMap(wrapper.computed);
  const childAfter = childId != null ? getElement(after, childId)?.computed ?? null : null;
  const childBefore = childId != null ? getElement(before, childId)?.computed ?? null : null;

  // (OVERRIDE) A flex/grid centering wrapper establishes a formatting context — so (A) below would
  // reject it — YET collapsing it to `place-self:center` on the sole child is provably layout-neutral
  // when the child's NEW parent is a statically-known grid that lets the wrapper fill its area (and the
  // wrapper carries nothing else). This is the ONE context-compensated case; verified render-identical
  // in Chromium. Everything that fails any rule falls through to the conservative criteria below.
  if (isContextCompensatedCentering(before, wrapper, wrapperComputed, childBefore, childAfter, norm)) {
    return { kind: 'provably-safe', wrapperId, childId };
  }

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
