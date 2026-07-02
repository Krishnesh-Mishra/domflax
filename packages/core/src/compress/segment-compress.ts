/**
 * @domflax/core — SEGMENT-LOCAL static extraction for dynamic class lists.
 *
 * An element whose className is a recognized `cn(…)`/`clsx(…)`/template-literal expression carries a
 * MIXED {@link ClassList}: STATIC segments (plain string chunks, each with a precise splice span) and
 * DYNAMIC segments (conditionals, identifiers, `${expr}` holes — opaque, byte-preserved). The full
 * runtime class set is unknown, so the element stays OPAQUE for flatten (`hasDynamic` stays true) —
 * but the provably-static chunks can still be compressed.
 *
 * ## The ORDER-SAFETY rule (why compression must be segment-local)
 *
 * `cn`/`twMerge` resolve conflicting utilities by ORDER (later wins), and any dynamic segment can add
 * or override classes at runtime. Rewriting is therefore only safe when it:
 *
 *   • rewrites WITHIN one static segment — replacing that segment's tokens with a shorter set that
 *     resolves to EXACTLY the same computed style, in the segment's original argument position, so
 *     every later-wins relationship against the other segments is preserved
 *     (`cn("px-4 py-4", cond && "p-2")` → `cn("p-4", cond && "p-2")`);
 *   • NEVER merges tokens across segments, NEVER reorders segments, NEVER touches dynamic segments.
 *
 * ## Correctness backstops (a doubtful segment is left byte-for-byte untouched)
 *
 *   • a segment containing a token the resolver does not know (`js-hook`, a typo, an undriveable
 *     Tailwind version) is left whole — its true style is unknown;
 *   • non-droppable tokens (variant-bound, selector-referenced, opaque utilities) are RETAINED
 *     verbatim in source order; only droppable utilities are re-derived (residual-subtracted, same as
 *     the whole-element path in `reverse-emit`);
 *   • the rewritten token set MUST re-resolve to the segment's exact original computed style
 *     (`normalizer.equals`) and MUST NOT be longer than the original — otherwise the rewrite is
 *     discarded.
 */

import { elementIds, getElement } from '../ir/builders';
import { createSyntheticSink } from '../passes/pipeline';
import type {
  ClassList,
  ClassSegment,
  ClassToken,
  ConditionKey,
  CssProperty,
  EmitContext,
  IRDocument,
  SafetyLevel,
  StyleBlock,
  StyleDecl,
  StyleMap,
  StyleNormalizer,
  StyleResolver,
} from '../ir/types';

/* ───────────────────────── helpers shared with reverse-emit ───────────────────────── */

/** Two token lists are equal iff same length and same tokens in the same order. */
export function sameTokens(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** The rendered `class="…"` byte length of a token list (tokens joined by single spaces). */
export function joinedLength(tokens: readonly string[]): number {
  if (tokens.length === 0) return 0;
  let len = tokens.length - 1; // joining spaces
  for (const t of tokens) len += t.length;
  return len;
}

/**
 * Return the RESIDUAL of `computed` after removing every declaration `covered` already reproduces
 * EXACTLY (same value + `!important`, in the same style condition). A declaration whose covered value
 * DIFFERS (i.e. it was overridden) stays in the residual: the final value still has to be emitted.
 */
export function residualStyle(
  computed: StyleMap,
  covered: StyleMap,
  norm: StyleNormalizer,
): StyleMap {
  const cov = norm.normalizeStyleMap(covered);
  const blocks = new Map<ConditionKey, StyleBlock>();
  for (const [key, block] of norm.normalizeStyleMap(computed).blocks) {
    const covBlock = cov.blocks.get(key);
    const decls = new Map<CssProperty, StyleDecl>();
    for (const [prop, decl] of block.decls) {
      const covDecl = covBlock?.decls.get(prop);
      if (covDecl && covDecl.value === decl.value && covDecl.important === decl.important) continue;
      decls.set(prop, decl);
    }
    if (decls.size > 0) blocks.set(key, { condition: block.condition, decls });
  }
  return { blocks };
}

/** SafetyLevel a `compress/*` rewrite carries — an opaque (floor-0) element is off-limits to it. */
export const COMPRESS_FLOOR: SafetyLevel = 1;

/* ───────────────────────── segment-local compression ───────────────────────── */

/**
 * Compress ONE static segment's tokens: retained (non-droppable) tokens survive verbatim in source
 * order; droppable utilities are replaced by the exact-cover emit over the residual style. Returns
 * the new token list, or `null` when the segment must stay untouched (any doubt ⇒ null).
 */
function compressSegmentTokens(
  tokens: readonly string[],
  resolver: StyleResolver,
  norm: StyleNormalizer,
  ctx: EmitContext,
  extended: boolean,
): readonly string[] | null {
  const res = resolver.resolve({ classes: [...tokens] });
  // A token the resolver cannot resolve ⇒ the segment's true style is UNKNOWN ⇒ hands off.
  if (res.unknown.length > 0) return null;

  const isDroppable = (t: string): boolean =>
    resolver.owns(t) && resolver.selectorUsage(t).droppable;
  // Variant-aware second tier (`extended`): also drop tokens the resolver VERIFIED it can re-emit
  // exactly (`hover:px-4`, `md:h-10`, …). Safe here because THIS function's mandatory re-resolve
  // equality backstop (below) rejects any rewrite that fails to reproduce the segment's exact style;
  // when the extended tier is rejected the caller retries with the conservative droppable-only tier.
  const isRebuildable = (t: string): boolean =>
    !isDroppable(t) && resolver.owns(t) && resolver.selectorUsage(t).rebuildable === true;
  const droppable = extended
    ? (t: string): boolean => isDroppable(t) || isRebuildable(t)
    : isDroppable;

  const retained = tokens.filter((t) => !droppable(t));
  // Nothing droppable ⇒ nothing can be shortened; keep the segment byte-for-byte.
  if (retained.length === tokens.length) return null;

  const segStyle = norm.normalizeStyleMap(res.styles);
  const covered = retained.length > 0 ? resolver.resolve({ classes: retained }).styles : null;
  const target = covered ? residualStyle(segStyle, covered, norm) : segStyle;

  const emitCtx: EmitContext = { ...ctx, sourceTokens: tokens.filter(droppable) };
  const emitted = resolver.emit(target, emitCtx).classes;
  // A resolver that reverse-synthesized nothing for a non-empty residual must never erase tokens.
  if (emitted.length === 0 && target.blocks.size > 0) return null;

  const emittedSet = new Set(emitted);
  const next: string[] = [];
  const seen = new Set<string>();
  // 1. Keep each existing token that is either retained (non-droppable) or still part of the
  //    emitted minimal set — preserving source order.
  for (const t of tokens) {
    if (seen.has(t)) continue;
    if (emittedSet.has(t) || !isDroppable(t)) {
      next.push(t);
      seen.add(t);
    }
  }
  // 2. Append any newly-emitted classes not already present, in emit order.
  for (const c of emitted) {
    if (seen.has(c)) continue;
    next.push(c);
    seen.add(c);
  }

  if (next.length === 0) return null; // never empty a segment
  if (sameTokens(next, tokens)) return null; // no churn when nothing actually changed

  // ORDER-SAFETY + correctness backstop: the rewritten segment must resolve (with the SAME
  // later-wins, in-segment order semantics) to EXACTLY the original segment's computed style, and
  // must not be longer than the original. Either failing ⇒ the segment stays untouched.
  if (!norm.equals(resolver.resolve({ classes: next }).styles, res.styles)) return null;
  if (joinedLength(next) > joinedLength(tokens)) return null;

  return next;
}

/**
 * Compress the REWRITABLE STATIC SEGMENTS of every element whose class list mixes static and dynamic
 * parts (`hasDynamic` && !`opaque` && `rewritable`). Purely segment-local (see module docs): the
 * element's overall opacity is unchanged — it remains blocked for flatten — and every dynamic
 * segment survives byte-for-byte. Mutates `doc` (the segments' token lists only).
 */
export function compressStaticSegments(
  doc: IRDocument,
  resolver: StyleResolver,
  norm: StyleNormalizer,
): void {
  const ctx: EmitContext = { normalizer: norm, sink: createSyntheticSink() };

  for (const id of elementIds(doc)) {
    const el = getElement(doc, id);
    if (!el) continue;
    const cl = el.classes;
    if (!cl.hasDynamic || cl.opaque || !cl.rewritable) continue;
    // Same gate as the whole-element compress path: an opaque (floor-0) node is never rewritten.
    if (el.meta.safetyFloor < COMPRESS_FLOOR) continue;

    let changed = false;
    const segments: ClassSegment[] = cl.segments.map((seg) => {
      if (seg.kind !== 'static' || !seg.span || seg.tokens.length === 0) return seg;
      const tokens = seg.tokens.map((t) => t.value);
      // Variant-aware (extended) tier first; on rejection fall back to the conservative tier —
      // byte-identical to the historical behavior (both share the equality + length backstops).
      const next =
        compressSegmentTokens(tokens, resolver, norm, ctx, true) ??
        compressSegmentTokens(tokens, resolver, norm, ctx, false);
      if (!next) return seg;
      changed = true;
      const classTokens: ClassToken[] = next.map((value) => ({ value }));
      return { ...seg, tokens: classTokens };
    });

    if (changed) {
      const nextList: ClassList = { ...cl, segments };
      el.classes = nextList;
    }
  }
}
