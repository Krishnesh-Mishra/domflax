/**
 * @domflax/patterns — flatten pattern: `passthrough-wrapper`.
 *
 * Collapses a purely-structural wrapper that exists for no reason at all:
 *
 *   <div><Child/></div>
 *
 * The wrapper paints nothing, establishes no box / formatting / stacking context, carries no
 * attributes beyond an (optional) inert class, holds exactly one element child, and is free of every
 * opacity barrier (ref / event-handlers / dynamic children / dangerous html / spread / component).
 * Such a `<div>` is pure DOM noise: removing it and hoisting the child is invisible to both paint
 * and layout.
 *
 * Authored with the declarative {@link pattern} API. The opacity-barrier + selector-safety guards
 * (ref/handlers/dynamic-children/raw-html/combinator/reparent-impact) are applied automatically for
 * every `flatten/*` pattern; the `where` predicates add the passthrough-specific requirements (no
 * box/formatting/stacking context, no own attrs, no dynamic/spread classes, not a component, not a
 * structural-pseudo subject).
 */

import type {
  DeepReadonly,
  IRElement,
  IRNode,
  IRNodeId,
  NodeLike,
  NodeMeta,
} from '@domflax/core';

import { hasDynamicClasses, not, pattern, type Matcher } from '@domflax/pattern-kit';

/* ───────────────────────── local meta/attr/selector matchers ───────────────────────── */

function metaOf(node: NodeLike): DeepReadonly<NodeMeta> | null {
  const n = node as DeepReadonly<IRNode>;
  return n.kind === 'element' ? (n as DeepReadonly<IRElement>).meta : null;
}

function elementOf(node: NodeLike): DeepReadonly<IRElement> | null {
  const n = node as DeepReadonly<IRNode>;
  return n.kind === 'element' ? (n as DeepReadonly<IRElement>) : null;
}

/**
 * Element establishes some box / formatting / stacking context, is a containing block, or exposes
 * custom properties to a descendant — any of which means removing its box could shift layout or
 * break a `var()` coupling, so it is NOT a passthrough.
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
  const el = elementOf(node);
  if (!el) return false;
  return el.attrs.entries.size > 0 || el.attrs.spreads.length > 0;
};

/**
 * Element is the subject of a structural pseudo (`:first/:last/:only/:nth-*`). Honours the meta flag
 * and the precomputed {@link SelectorIndex}.
 */
const targetedByStructuralPseudo: Matcher = (node, ctx) => {
  const el = elementOf(node);
  if (!el) return false;
  if (el.meta.targetedByStructuralPseudo) return true;
  return ctx.selectors.targetedByStructuralPseudo(el.id as unknown as IRNodeId);
};

/* ───────────────────────── the pattern ───────────────────────── */

/**
 * Flatten a do-nothing `<div>` wrapper into its sole element child, folding any inheritable styles
 * down first so inherited values survive the box removal.
 */
export const passthroughWrapper = pattern({
  name: 'passthrough-wrapper',
  category: 'flatten/passthrough-wrapper',
  safety: 2,
  doc: {
    title: 'Flatten passthrough wrapper',
    summary:
      'A div with no own visual/box style, no attributes beyond an inert class, exactly one ' +
      'element child, and no opacity barriers is removed; its sole child is hoisted in its place.',
    before: '<div><Child/></div>',
    after: '<Child/>',
    safetyRationale:
      'Wrapper paints nothing and establishes no layout/paint/var context, carries no ' +
      'ref/handlers/dynamic-children/html/spread/component identity, owns no targetable attrs, ' +
      'and is not a combinator/structural-pseudo subject (reparenting changes no match-set); ' +
      'inheritable styles are folded onto the child before removal.',
  },
  match: {
    tag: 'div',
    onlyChild: 'element',
    paintsNothing: true,
    where: [
      not(establishesContext),
      not(hasOwnAttrs),
      not(hasDynamicClasses),
      not(hasSpreadAttrs),
      not(isComponentNode),
      not(targetedByStructuralPseudo),
    ],
  },
  rewrite: { flattenInto: 'child' },
  examples: [
    {
      before: '<div className="flex"><a className="bg-red-200">Link</a></div>',
      after: '<a className="bg-red-200">Link</a>',
    },
    {
      // A ref pins the wrapper's element identity (a hard opacity barrier) → not a passthrough.
      noMatch: '<div ref={rootRef}><a className="bg-red-200">Link</a></div>',
    },
  ],
});
