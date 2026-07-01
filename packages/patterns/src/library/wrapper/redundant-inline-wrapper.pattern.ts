/**
 * @domflax/patterns — flatten pattern: `redundant-inline-wrapper`.
 *
 * Collapses a purely-structural INLINE wrapper:
 *
 *   <span><Child/></span>            (display:inline, no own style)
 *
 * An inline `<span>` that paints nothing, establishes no box / formatting / stacking context, carries
 * no attributes beyond an (optional) inert class, declares no custom properties, and holds exactly one
 * element child is pure inline noise. An empty inline box merely wraps its child's box; removing it and
 * hoisting the child leaves both paint and layout untouched (the surviving child folds the inheritable
 * declarations the span carried).
 *
 * This is the inline sibling of `passthrough-wrapper` (which targets `<div>`): the same opacity-barrier
 * + selector-safety guards are auto-applied by the `pattern()` factory for every `flatten/*` pattern;
 * the `where` predicates add the inline-passthrough requirements (display must be the inline default,
 * no box/formatting/stacking context or var coupling, no own attrs / dynamic-or-spread classes, not a
 * component, not a structural-pseudo subject).
 */

import type {
  CssProperty,
  DeepReadonly,
  IRElement,
  IRNode,
  IRNodeId,
  NodeLike,
  NodeMeta,
  StyleMap,
} from '@domflax/core';

import { definePattern, hasDynamicClasses, not, type Matcher } from '@domflax/pattern-kit';

/* ───────────────────────── local meta/attr/selector matchers ───────────────────────── */

function asEl(node: NodeLike): DeepReadonly<IRElement> | null {
  const n = node as DeepReadonly<IRNode>;
  return n.kind === 'element' ? (n as DeepReadonly<IRElement>) : null;
}

function metaOf(node: NodeLike): DeepReadonly<NodeMeta> | null {
  return asEl(node)?.meta ?? null;
}

/**
 * Element establishes some box / formatting / stacking context, is a containing block, or exposes
 * custom properties to a descendant — removing its box could shift layout or sever a `var()` coupling,
 * so it is NOT an inline passthrough.
 */
const establishesContext: Matcher = (node) => {
  const m = metaOf(node);
  if (!m) return false;
  return (
    m.establishesBox ||
    m.establishesFormattingContext ||
    m.establishesStackingContext ||
    m.isContainingBlock ||
    m.declaresCustomProperties
  );
};

/** Hard opacity barriers beyond the auto-applied set: spread attrs, component identity. */
const hasSpreadAttrs: Matcher = (node) => metaOf(node)?.hasSpreadAttrs ?? false;
const isComponentNode: Matcher = (node) => metaOf(node)?.isComponent ?? false;

/** Element carries own attributes (id / data-* / …) beyond its class list — possible selector/JS hook. */
const hasOwnAttrs: Matcher = (node) => {
  const el = asEl(node);
  if (!el) return false;
  return el.attrs.entries.size > 0 || el.attrs.spreads.length > 0;
};

/**
 * Element is the subject of a structural pseudo (`:first/:last/:only/:nth-*`). Honours the meta flag
 * and the precomputed {@link SelectorIndex}.
 */
const targetedByStructuralPseudo: Matcher = (node, ctx) => {
  const el = asEl(node);
  if (!el) return false;
  if (el.meta.targetedByStructuralPseudo) return true;
  return ctx.selectors.targetedByStructuralPseudo(el.id as unknown as IRNodeId);
};

const DISPLAY = 'display' as CssProperty;

/**
 * Element sets `display` to anything other than the inline default in ANY condition. An
 * inline-block / block / flex / grid / contents span is NOT an inline passthrough — its box (or lack
 * of one) participates in layout differently from a bare inline box.
 */
const hasNonInlineDisplay: Matcher = (node, ctx) => {
  const el = asEl(node);
  if (!el) return false;
  const sm: StyleMap = ctx.computedOf(el as unknown as NodeLike) ?? (el.computed as StyleMap);
  for (const block of sm.blocks.values()) {
    const decl = block.decls.get(DISPLAY);
    if (decl && String(decl.value) !== 'inline') return true;
  }
  return false;
};

/* ───────────────────────── the pattern ───────────────────────── */

/**
 * Flatten a do-nothing inline `<span>` wrapper into its sole element child, folding any inheritable
 * styles down first so inherited values survive the box removal.
 */
export const redundantInlineWrapper = definePattern({
  name: 'redundant-inline-wrapper',
  category: 'flatten/wrapper/redundant-inline-wrapper',
  safety: 2,
  doc: {
    title: 'Flatten redundant inline wrapper',
    summary:
      'An inline span with no own visual/box style, no attributes beyond an inert class, exactly ' +
      'one element child, and no opacity barriers is removed; its sole child is hoisted in its place.',
    before: '<span><Child/></span>',
    after: '<Child/>',
    safetyRationale:
      'An empty inline box paints nothing and establishes no layout/paint/var context; with the ' +
      'inline default display and a single element child its removal changes no paint and no flow. ' +
      'The span carries no ref/handlers/dynamic-children/html/spread/component identity, owns no ' +
      'targetable attrs, and is not a combinator/structural-pseudo subject; inheritable styles are ' +
      'folded onto the child before removal.',
  },
  match: {
    tag: 'span',
    onlyChild: 'element',
    paintsNothing: true,
    where: [
      not(hasNonInlineDisplay),
      not(establishesContext),
      not(hasOwnAttrs),
      not(hasDynamicClasses),
      not(hasSpreadAttrs),
      not(isComponentNode),
      not(targetedByStructuralPseudo),
    ],
  },
  rewrite: { flattenInto: 'child' },
  test: {
    cases: [
      {
        // An empty inline span paints nothing and establishes no context → a provably-safe flatten:
        // the span is removed and its sole child hoisted in place.
        before: '<span><a className="text-blue-500">Link</a></span>',
        after: '<a className="text-blue-500">Link</a>',
      },
    ],
    noMatch: [
      // A ref pins the span's element identity (a hard opacity barrier) → not a passthrough.
      '<span ref={spanRef}><a className="text-blue-500">Link</a></span>',
      // The span paints its own background (own visual style) → kept.
      '<span className="bg-green-200"><a className="text-blue-500">Link</a></span>',
      // Non-inline display (inline-block) participates in layout differently → kept.
      '<span className="inline-block"><a className="text-blue-500">Link</a></span>',
    ],
  },
});
