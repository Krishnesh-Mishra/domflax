/**
 * @domflax/patterns — flatten pattern: `display-contents-wrapper`.
 *
 * Collapses a wrapper that has explicitly opted OUT of generating a box:
 *
 *   <div style="display:contents"><Child/></div>   →   <Child/>
 *
 * `display:contents` makes an element generate NO box of its own — its children render exactly as if
 * they were direct children of the element's parent. A `display:contents` wrapper with a single
 * element child is therefore already a layout passthrough: it contributes nothing to flow, paint
 * (a contents box paints nothing), formatting, stacking, or containing-block resolution. Removing it
 * and hoisting the child produces a tree that is layout-identical — the wrapper's only remaining
 * effect was inheritance, which is preserved by folding inheritable declarations onto the child first.
 *
 * This is the safest possible wrapper-elimination: the box being removed provably did not exist.
 * The opacity-barrier + selector-safety guards (ref/handlers/dynamic-children/raw-html/combinator/
 * reparent-impact) are auto-applied for every `flatten/*` pattern; the `where` predicates add the
 * passthrough-specific requirements (no own attrs / dynamic-or-spread classes, no `var()` coupling,
 * not a component, not a structural-pseudo subject).
 *
 * (Chosen as the safe variant of the size-hoisting "full-size passthrough" idea: hoisting an explicit
 * `width/height:100%` onto a child is only sound when the child is block-level and unsized, which is
 * not knowable from the wrapper alone — whereas a `display:contents` box is a passthrough by definition.)
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

function asEl(node: NodeLike): DeepReadonly<IRElement> | null {
  const n = node as DeepReadonly<IRNode>;
  return n.kind === 'element' ? (n as DeepReadonly<IRElement>) : null;
}

function metaOf(node: NodeLike): DeepReadonly<NodeMeta> | null {
  return asEl(node)?.meta ?? null;
}

/**
 * Element exposes custom properties to a descendant — removing its box could sever a `var()` coupling,
 * so it is NOT a free passthrough. (A `display:contents` box establishes no formatting/stacking/box
 * context and is no containing block, so those flags need not be checked.)
 */
const declaresCustomProperties: Matcher = (node) => metaOf(node)?.declaresCustomProperties ?? false;

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

/* ───────────────────────── the pattern ───────────────────────── */

/**
 * Flatten a `display:contents` wrapper (a box that generates no box) into its sole element child,
 * folding any inheritable styles down first so inherited values survive the removal.
 */
export const displayContentsWrapper = pattern({
  name: 'display-contents-wrapper',
  category: 'flatten/display-contents-wrapper',
  safety: 2,
  doc: {
    title: 'Flatten display:contents wrapper',
    summary:
      'A div with display:contents (which generates no box) wrapping a single element child, with ' +
      'no own visual style, no attributes beyond an inert class, and no opacity barriers, is removed; ' +
      'its sole child is hoisted in its place.',
    before: '<div style="display:contents"><Child/></div>',
    after: '<Child/>',
    safetyRationale:
      'A display:contents element generates no box at all, so its children already render as direct ' +
      "children of its parent; removing it is layout-identical. It paints nothing, establishes no " +
      'formatting/stacking/box context, is no containing block, carries no ' +
      'ref/handlers/dynamic-children/html/spread/component identity, owns no targetable attrs / ' +
      'custom-property coupling, and is not a combinator/structural-pseudo subject; inheritable ' +
      'styles are folded onto the child before removal.',
  },
  match: {
    tag: 'div',
    style: { display: 'contents' },
    onlyChild: 'element',
    paintsNothing: true,
    where: [
      not(declaresCustomProperties),
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
      before: '<div className="contents"><a className="text-blue-500">Link</a></div>',
      after: '<a className="text-blue-500">Link</a>',
    },
    {
      // A ref pins the wrapper's element identity (a hard opacity barrier) → not a passthrough.
      noMatch: '<div className="contents" ref={rootRef}><a className="text-blue-500">Link</a></div>',
    },
  ],
});
