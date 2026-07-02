/**
 * @domflax/core — the shared reverse-emit step (computed → className).
 *
 * The backend re-prints `className` from each element's {@link ClassList}, but the pass manager
 * records optimized styles on `computed`. This module folds those optimized computed styles back
 * into the element's static class tokens, and is the SINGLE source of truth shared by every
 * orchestrator (the `domflax` meta package, `@domflax/cli`, and the pattern auto-test harness) so
 * their pipelines cannot diverge.
 *
 * ## Only STYLE-DIRTY elements are re-emitted (never inflate a bystander)
 *
 * Reverse-emit runs ONLY on elements a pass actually rewrote the computed style of — `meta.styleDirty`
 * (a `setClassList`, a `mergeStyle` onto it, or an inherited fold into it). An element that was merely
 * `touched` as a STRUCTURAL BYSTANDER — a child was flattened/unwrapped, a sibling merged/moved, a
 * node inserted next to it — never has its own computed changed, so its `class` attribute is left
 * BYTE-FOR-BYTE IDENTICAL. This is what stops a real custom-CSS site from INFLATING: an unchanged
 * `<div class="product-art">` can no longer gain a redundant `.bg-cream-deep` just because an inert
 * child next to it was flattened.
 *
 * ## REPLACE, not append — with retained-class coverage SUBTRACTED
 *
 * For every style-dirty, rewritable (non-opaque, non-dynamic) element we ask the resolver for the
 * MINIMAL class set reproducing the element's computed style, then REPLACE the element's droppable
 * tokens with it — rather than appending. Replacing is what lets a compress pass actually shorten
 * output: `px-4 py-4` collapses to `p-4`, equal `w/h` to `size-*`, the four insets to `inset-0`, and
 * fully-overridden duplicates simply disappear.
 *
 * Crucially, before choosing what to emit we SUBTRACT the style already supplied by the element's
 * RETAINED (kept, non-droppable) classes: we emit only for the RESIDUAL declarations those classes do
 * not already reproduce. So reverse-emit can never materialize a utility for a property a semantic
 * class the element keeps already sets (the `.product-art` background is never re-added as
 * `.bg-cream-deep`). Output therefore never grows with a class whose contribution is already covered.
 *
 * ## Droppability gate (never lose a load-bearing class)
 *
 * A token is only removed when `resolver.selectorUsage(token).droppable` is true — i.e. it is a
 * plain, resolver-owned utility whose entire contribution is reproducible from `computed`. Tokens
 * that are unknown to the resolver, opaque (combinator/at-rule utilities whose effect never folds
 * onto the element's own box), variant-bound, or referenced by a custom-CSS selector are NOT
 * droppable and are preserved verbatim. As a safety net, if the residual `emit` produces nothing at
 * all we leave the element's tokens untouched (a resolver that failed to load must never erase
 * classes).
 *
 * ## Mixed (cn()/template) class lists — segment-local static extraction
 *
 * An element whose className mixes static string chunks with dynamic expressions is NEVER processed
 * by the whole-element path above (its full class set is unknown). Instead its rewritable static
 * segments are compressed individually by {@link import('./segment-compress').compressStaticSegments}
 * (invoked first, below) — order-safe, dynamic parts byte-preserved.
 */

import { elementIds, getElement } from './builders';
import { createSyntheticSink } from './pipeline';
import {
  COMPRESS_FLOOR,
  compressStaticSegments,
  joinedLength,
  residualStyle,
  sameTokens,
} from './segment-compress';
import { convertInlineStyles } from './style-to-class';
import type {
  ClassList,
  ClassSegment,
  ClassToken,
  EmitContext,
  IRDocument,
  IRElement,
  StyleNormalizer,
  StyleResolver,
} from './types';

/** All static class tokens of a {@link ClassList}, in source order. */
function staticTokensOf(cl: ClassList): string[] {
  const out: string[] = [];
  for (const seg of cl.segments) {
    if (seg.kind === 'static') for (const t of seg.tokens) out.push(t.value);
  }
  return out;
}

/** A rewritable static {@link ClassList} over `tokens`, preserving the previous list's spans. */
function staticClassList(prev: ClassList, tokens: readonly string[]): ClassList {
  const classTokens: ClassToken[] = tokens.map((value) => ({ value }));
  const seg: ClassSegment = { kind: 'static', tokens: classTokens };
  return {
    form: 'string-literal',
    segments: [seg],
    valueSpan: prev.valueSpan,
    attrSpan: prev.attrSpan,
    hasDynamic: false,
    opaque: false,
    rewritable: true,
  };
}

/**
 * Fold each rewritable element's computed style back into the MINIMAL static class-token set — the
 * general compress engine (see module docs + {@link import('./compress-engine')}). Mutates `doc`.
 *
 * TWO kinds of element are processed, and their guarantees differ:
 *
 *   • STYLE-DIRTY — a pass rewrote this element's own computed style (a flatten fold / merge). Its
 *     computed CHANGED, so its classes MUST be re-derived to represent the new style (which may
 *     legitimately need MORE tokens than before). Handled exactly as it always was.
 *
 *   • COMPRESS-ONLY — no pass touched it; we run the exact-cover engine purely to SHORTEN its class
 *     string (`px-4 py-4 → p-4`, drop a redundant class, pick a custom class that covers the same
 *     style, …). This is a pure class-string rewrite that must NEVER change the render or GROW the
 *     output, so it carries two extra hard backstops below: the rewritten set must re-resolve to the
 *     element's exact computed style, and it must not be longer than the original. A structural
 *     bystander with no compression opportunity therefore keeps its `class` attribute byte-for-byte.
 */
export function syncClassesFromComputed(
  doc: IRDocument,
  resolver: StyleResolver,
  norm: StyleNormalizer,
): void {
  // STATIC EXTRACTION for mixed (cn()/clsx()/template-literal) class lists: compress each provably-
  // static segment IN PLACE (segment-local, order-safe — see ./segment-compress). Fully-dynamic /
  // opaque lists and every dynamic segment are untouched; such elements stay opaque for flatten.
  compressStaticSegments(doc, resolver, norm);

  // INLINE-STYLE ⇄ CLASS conversion: fold a provably-static `style` attribute into the class cover
  // when that is byte-shorter AND re-resolves to the exact same computed style (see ./style-to-class).
  convertInlineStyles(doc, resolver, norm);

  const sink = createSyntheticSink();
  // A token is safe to drop/replace only when the resolver OWNS it (an unknown / JS-hook / typo class
  // is preserved verbatim) AND its whole contribution is a plain, reproducible subject utility. Owning
  // is checked explicitly so a custom-CSS resolver that has no usage record for an unknown token (its
  // conservative default is "droppable") can never erase it.
  const isDroppable = (t: string): boolean =>
    resolver.owns(t) && resolver.selectorUsage(t).droppable;
  // Second tier (VARIANT-AWARE compression): a token that is not unconditionally droppable but whose
  // exact full effect the resolver VERIFIED it can re-emit (e.g. `hover:px-4`). Dropping such a token
  // is only ever committed under the mandatory re-resolve equality backstop below.
  const isRebuildable = (t: string): boolean =>
    !isDroppable(t) && resolver.owns(t) && resolver.selectorUsage(t).rebuildable === true;

  /**
   * One re-derivation attempt under a droppability predicate: retained tokens survive verbatim, the
   * residual is re-emitted (with the droppable originals offered as cover candidates), and the merged
   * list is returned — or null when nothing was emitted / nothing can change.
   */
  const attempt = (
    tokens: readonly string[],
    el: IRElement,
    droppable: (t: string) => boolean,
    compressOnly: boolean,
  ): string[] | null => {
    const retained = tokens.filter((t) => !droppable(t));
    // A pure-compress element with NOTHING droppable can never shorten — leave it byte-for-byte.
    if (compressOnly && retained.length === tokens.length) return null;

    const covered = retained.length > 0 ? resolver.resolve({ classes: retained }).styles : null;
    const target = covered ? residualStyle(el.computed, covered, norm) : el.computed;

    // Minimal class set reproducing the residual (computed MINUS retained-class coverage).
    const ctx: EmitContext = { normalizer: norm, sink, sourceTokens: tokens.filter(droppable) };
    const emitted = resolver.emit(target, ctx).classes;
    // A resolver that reverse-synthesized nothing must never erase the element's classes.
    if (emitted.length === 0) return null;

    const emittedSet = new Set(emitted);
    const next: string[] = [];
    const seen = new Set<string>();

    // 1. Keep each existing token that is either NOT droppable (unknown / opaque / variant /
    //    selector-bound) or still part of the emitted minimal set — preserving source order.
    for (const t of tokens) {
      if (seen.has(t)) continue;
      const keep = emittedSet.has(t) || !droppable(t);
      if (keep) {
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
    return next;
  };

  for (const id of elementIds(doc)) {
    const el = getElement(doc, id);
    if (!el) continue;
    if (el.classes.opaque || el.classes.hasDynamic) continue;

    const compressOnly = !el.meta.styleDirty;
    // COMPRESS-ONLY mirrors the compress patterns' applier gate: an opaque (floor-0) element — an HTML
    // `id`/`on*=`/`<script>` node, a synthetic wrapper — is never rewritten. STYLE-DIRTY elements were
    // already rewritten by an op the applier authorized, so their floor is irrelevant here.
    if (compressOnly && el.meta.safetyFloor < COMPRESS_FLOOR) continue;

    const tokens = staticTokensOf(el.classes);
    if (tokens.length === 0) continue;

    // TIER 2 first — variant-aware: additionally drop verified-rebuildable tokens, gated by a
    // MANDATORY re-resolve equality backstop (regardless of styleDirty). Failing the backstop falls
    // through to the conservative tier-1 attempt, which is byte-identical to the historical behavior.
    if (tokens.some(isRebuildable)) {
      const next = attempt(tokens, el, (t) => isDroppable(t) || isRebuildable(t), compressOnly);
      if (
        next &&
        !sameTokens(next, tokens) &&
        norm.equals(resolver.resolve({ classes: next }).styles, el.computed) &&
        (!compressOnly || joinedLength(next) <= joinedLength(tokens))
      ) {
        el.classes = staticClassList(el.classes, next);
        continue;
      }
    }

    // TIER 1 — plain droppable utilities only (the historical path).
    const next = attempt(tokens, el, isDroppable, compressOnly);
    if (!next) continue;
    if (sameTokens(next, tokens)) continue; // no churn when nothing actually changed

    if (compressOnly) {
      // Hard correctness backstop for a pure compress: the rewritten token set must reproduce the
      // element's EXACT computed style (never change a pixel) and must NOT be longer than the original
      // (never inflate). Either failing ⇒ keep the original classes untouched.
      if (!norm.equals(resolver.resolve({ classes: next }).styles, el.computed)) continue;
      if (joinedLength(next) > joinedLength(tokens)) continue;
    }

    el.classes = staticClassList(el.classes, next);
  }
}
