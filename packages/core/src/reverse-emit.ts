/**
 * @domflax/core — the shared reverse-emit step (computed → className).
 *
 * The backend re-prints `className` from each element's {@link ClassList}, but the pass manager
 * records optimized styles on `computed`. This module folds those optimized computed styles back
 * into the element's static class tokens, and is the SINGLE source of truth shared by every
 * orchestrator (the `domflax` meta package, `@domflax/cli`, and the pattern auto-test harness) so
 * their pipelines cannot diverge.
 *
 * ## REPLACE, not append
 *
 * For every TOUCHED, rewritable (non-opaque, non-dynamic) element we ask the resolver for the
 * MINIMAL class set reproducing the element's FULL computed style (`resolver.emit(el.computed)`),
 * then REPLACE the element's static tokens with it — rather than appending. Replacing is what lets
 * a compress pass actually shorten output: `px-4 py-4` collapses to `p-4`, equal `w/h` to `size-*`,
 * the four insets to `inset-0`, and fully-overridden duplicates simply disappear.
 *
 * ## Droppability gate (never lose a load-bearing class)
 *
 * A token is only removed when `resolver.selectorUsage(token).droppable` is true — i.e. it is a
 * plain, resolver-owned utility whose entire contribution is reproducible from `computed`. Tokens
 * that are unknown to the resolver, opaque (combinator/at-rule utilities whose effect never folds
 * onto the element's own box), variant-bound, or referenced by a custom-CSS selector are NOT
 * droppable and are preserved verbatim. As a safety net, if `emit` produces nothing at all we leave
 * the element's tokens untouched (a resolver that failed to load must never erase classes).
 */

import { elementIds, getElement } from './builders';
import { createSyntheticSink } from './pipeline';
import type {
  ClassList,
  ClassSegment,
  ClassToken,
  EmitContext,
  IRDocument,
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

/** Two token lists are equal iff same length and same tokens in the same order. */
function sameTokens(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Fold every TOUCHED, rewritable element's optimized computed style back into the MINIMAL static
 * class-token set (see module docs). Mutates `doc` in place.
 */
export function syncClassesFromComputed(
  doc: IRDocument,
  resolver: StyleResolver,
  norm: StyleNormalizer,
): void {
  const sink = createSyntheticSink();
  for (const id of elementIds(doc)) {
    const el = getElement(doc, id);
    if (!el || !el.meta.touched) continue;
    if (el.classes.opaque || el.classes.hasDynamic) continue;

    const tokens = staticTokensOf(el.classes);

    // Minimal class set reproducing the FULL computed style.
    const ctx: EmitContext = { normalizer: norm, sink };
    const emitted = resolver.emit(el.computed, ctx).classes;
    // A resolver that reverse-synthesized nothing must never erase the element's classes.
    if (emitted.length === 0) continue;

    const emittedSet = new Set(emitted);
    const next: string[] = [];
    const seen = new Set<string>();

    // 1. Keep each existing token that is either NOT droppable (unknown / opaque / variant /
    //    selector-bound) or still part of the emitted minimal set — preserving source order.
    for (const t of tokens) {
      if (seen.has(t)) continue;
      const keep = emittedSet.has(t) || !resolver.selectorUsage(t).droppable;
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

    if (sameTokens(next, tokens)) continue; // no churn when nothing actually changed
    el.classes = staticClassList(el.classes, next);
  }
}
