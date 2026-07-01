/**
 * @domflax/pattern-kit — composable matcher vocabulary.
 *
 * A {@link Matcher} is a PURE predicate over a node + its {@link MatchContext}. Matchers never
 * mutate; they only read the (DeepReadonly) IR and the precomputed targeting/selector facts the
 * context exposes. Authors compose them with {@link and}/{@link or}/{@link not} and feed the
 * result into a pattern's `evaluate`.
 *
 * Style-aware matchers (`computed`, `hasOwnVisualStyle`) reason over the NORMALIZED StyleMap via
 * the shared normalizer in `./normalize`, so they query meaning, not raw CSS strings.
 */

import type {
  DeepReadonly,
  ElementLike,
  IRElement,
  IRNode,
  IRNodeId,
  MatchContext,
  NodeLike,
  StyleMap,
} from '@domflax/core';

import { isStyleSuperset, normalizer } from './normalize';

/** A pure predicate: does `node` satisfy this condition in the given match context? */
export type Matcher = (node: NodeLike, ctx: MatchContext) => boolean;

/* ───────────────────────── internal helpers ───────────────────────── */

function asElement(node: NodeLike): DeepReadonly<IRElement> | null {
  const n = node as DeepReadonly<IRNode>;
  return n.kind === 'element' ? (n as DeepReadonly<IRElement>) : null;
}

function elementChildrenOf(
  el: DeepReadonly<IRElement>,
  ctx: MatchContext,
): DeepReadonly<IRElement>[] {
  const out: DeepReadonly<IRElement>[] = [];
  for (const childId of el.children) {
    const child = ctx.doc.nodes.get(childId);
    if (child && child.kind === 'element') out.push(child as DeepReadonly<IRElement>);
  }
  return out;
}

/* ───────────────────────── boolean combinators ───────────────────────── */

/** Logical AND. Empty list ⇒ always matches. Short-circuits on the first failure. */
export function and(...matchers: readonly Matcher[]): Matcher {
  return (node, ctx) => matchers.every((m) => m(node, ctx));
}

/** Logical OR. Empty list ⇒ never matches. Short-circuits on the first success. */
export function or(...matchers: readonly Matcher[]): Matcher {
  return (node, ctx) => matchers.some((m) => m(node, ctx));
}

/** Logical NOT. */
export function not(matcher: Matcher): Matcher {
  return (node, ctx) => !matcher(node, ctx);
}

/* ───────────────────────── structural matchers ───────────────────────── */

/** Matches any element; with `tag`, only elements whose (case-insensitive) tag equals it. */
export function isElement(tag?: string): Matcher {
  const want = tag?.toLowerCase();
  return (node) => {
    const el = asElement(node);
    if (!el) return false;
    return want === undefined || el.tag.toLowerCase() === want;
  };
}

/** Matches an element with exactly one ELEMENT child (text/expr/comment children ignored). */
export const hasSingleElementChild: Matcher = (node, ctx) => {
  const el = asElement(node);
  if (!el) return false;
  return elementChildrenOf(el, ctx).length === 1;
};

/* ───────────────────────── style matchers ───────────────────────── */

/**
 * Matches when the node's computed StyleMap is a SUPERSET of `partial` — i.e. every declaration
 * in `partial` is present in `node.computed` with an equal normalized value. Comparison is
 * meaning-based (both sides normalized first). Empty `partial` always matches.
 */
export function computed(partial: StyleMap): Matcher {
  return (node, ctx) => {
    const el = asElement(node);
    if (!el) return false;
    const full = ctx.computedOf(el as unknown as NodeLike) ?? (el.computed as StyleMap);
    return isStyleSuperset(full as StyleMap, partial, normalizer);
  };
}

/** Visual (paint-establishing) properties that count as "own visual style", beyond pure layout. */
const VISUAL_PROPERTIES: ReadonlySet<string> = new Set<string>([
  'background',
  'background-color',
  'background-image',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-top-style',
  'border-right-style',
  'border-bottom-style',
  'border-left-style',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  // `border-radius` is expanded to its four corner longhands by the shared normalizer, so the
  // paint-establishing check must match those (a rounded wrapper still clips its background).
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
  'box-shadow',
  'outline',
  'outline-width',
  'outline-style',
  'outline-color',
  'text-shadow',
  'filter',
  'backdrop-filter',
  'mix-blend-mode',
  'opacity',
]);

/** Values that mean "no paint" — a visual property set to one of these does NOT count. */
const EMPTY_VISUAL_VALUES: ReadonlySet<string> = new Set<string>([
  'none',
  '0',
  'normal',
  'transparent',
  'rgba(0, 0, 0, 0)',
  'initial',
  'unset',
  'auto',
]);

/**
 * Matches when the element paints something of its own: a meaningful background, border, shadow,
 * outline, filter, etc. across ANY style condition. Honours the frontend-set `meta.hasOwnVisualStyle`
 * fast-path, then falls back to scanning the normalized computed StyleMap.
 */
export const hasOwnVisualStyle: Matcher = (node, ctx) => {
  const el = asElement(node);
  if (!el) return false;
  if (el.meta.hasOwnVisualStyle) return true;
  // SAFETY (Layer 2): an element with an UNRESOLVED class has an UNKNOWN true style — we cannot prove
  // it paints nothing, so it must NOT satisfy `paintsNothing` (`not(hasOwnVisualStyle)`). Reporting
  // "has own visual style" here makes every flatten pattern gated on paintsNothing decline to match,
  // so the element is preserved. This is the primary flatten fail-safe (the flatten-safety classifier
  // is the backstop). Compress is unaffected — its guards never consult hasOwnVisualStyle.
  if (el.meta.hasUnresolvedClasses) return true;

  const computedMap = ctx.computedOf(el as unknown as NodeLike) ?? (el.computed as StyleMap);
  const norm = normalizer.normalizeStyleMap(computedMap as StyleMap);
  for (const block of norm.blocks.values()) {
    for (const decl of block.decls.values()) {
      if (!VISUAL_PROPERTIES.has(String(decl.property))) continue;
      if (!EMPTY_VISUAL_VALUES.has(String(decl.value))) return true;
    }
  }
  return false;
};

/* ───────────────────────── opacity-barrier / meta matchers ───────────────────────── */

/** Element carries a `ref` (hard opacity barrier). */
export const hasRef: Matcher = (node) => asElement(node)?.meta.hasRef ?? false;

/** Element has event handlers (onClick, …). */
export const hasEventHandlers: Matcher = (node) => asElement(node)?.meta.hasEventHandlers ?? false;

/** Element has dynamic children (mapped/conditional islands). */
export const hasDynamicChildren: Matcher = (node) =>
  asElement(node)?.meta.hasDynamicChildren ?? false;

/** Element's class list contains a dynamic segment (template/expr) → not freely rewritable. */
export const hasDynamicClasses: Matcher = (node) => asElement(node)?.classes.hasDynamic ?? false;

/**
 * Element's class list is wholly dynamic / spread-derived (`classes.opaque`, or spread attrs) — its
 * concrete tokens can't be seen or statically rewritten, so a class-rewriting (compress) pattern
 * must decline. Delegates to the context's authoritative {@link MatchContext.isOpaque}.
 */
export const opaque: Matcher = (node, ctx) => {
  const el = asElement(node);
  if (!el) return false;
  return ctx.isOpaque(el as unknown as ElementLike);
};

/**
 * Element is the subject of a combinator selector (`>`/`+`/`~`). Honours the frontend-set meta
 * flag and the precomputed {@link SelectorIndex} in the context.
 */
export const targetedByCombinator: Matcher = (node, ctx) => {
  const el = asElement(node);
  if (!el) return false;
  if (el.meta.targetedByCombinator) return true;
  // `el.id` is a branded number; DeepReadonly widens the brand, so re-narrow for the index call.
  return ctx.selectors.targetedByCombinator(el.id as unknown as IRNodeId);
};
