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
 */

import { elementIds, getElement } from './builders';
import { createSyntheticSink } from './pipeline';
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
 * Return the RESIDUAL of `computed` after removing every declaration the element's retained classes
 * already reproduce EXACTLY (same value + `!important`, in the same style condition). What's left is
 * the set of declarations the emitted classes must actually cover — so reverse-emit never re-adds a
 * utility for a property a kept class already supplies. A declaration whose retained-class value
 * DIFFERS from the computed one (i.e. the class was overridden) is kept in the residual: the final
 * value still has to be emitted by something.
 */
function residualStyle(computed: StyleMap, covered: StyleMap, norm: StyleNormalizer): StyleMap {
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

/** The rendered `class="…"` byte length of a token list (tokens joined by single spaces). */
function joinedLength(tokens: readonly string[]): number {
  if (tokens.length === 0) return 0;
  let len = tokens.length - 1; // joining spaces
  for (const t of tokens) len += t.length;
  return len;
}

/** SafetyLevel a `compress/*` rewrite carried — an opaque (floor-0) element is off-limits to it. */
const COMPRESS_FLOOR: SafetyLevel = 1;

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
  const sink = createSyntheticSink();
  // A token is safe to drop/replace only when the resolver OWNS it (an unknown / JS-hook / typo class
  // is preserved verbatim) AND its whole contribution is a plain, reproducible subject utility. Owning
  // is checked explicitly so a custom-CSS resolver that has no usage record for an unknown token (its
  // conservative default is "droppable") can never erase it.
  const isDroppable = (t: string): boolean =>
    resolver.owns(t) && resolver.selectorUsage(t).droppable;

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

    // Tokens that are ALWAYS retained (unknown / opaque / variant / selector-bound). Their style is
    // subtracted from the computed map so we never re-emit a class for a property they already cover.
    const retained = tokens.filter((t) => !isDroppable(t));
    // A pure-compress element with NOTHING droppable can never shorten — leave it byte-for-byte.
    if (compressOnly && retained.length === tokens.length) continue;

    const covered = retained.length > 0 ? resolver.resolve({ classes: retained }).styles : null;
    const target = covered ? residualStyle(el.computed, covered, norm) : el.computed;

    // Minimal class set reproducing the residual (computed MINUS retained-class coverage).
    const ctx: EmitContext = { normalizer: norm, sink };
    const emitted = resolver.emit(target, ctx).classes;
    // A resolver that reverse-synthesized nothing must never erase the element's classes.
    if (emitted.length === 0) continue;

    const emittedSet = new Set(emitted);
    const next: string[] = [];
    const seen = new Set<string>();

    // 1. Keep each existing token that is either NOT droppable (unknown / opaque / variant /
    //    selector-bound) or still part of the emitted minimal set — preserving source order.
    for (const t of tokens) {
      if (seen.has(t)) continue;
      const keep = emittedSet.has(t) || !isDroppable(t);
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
