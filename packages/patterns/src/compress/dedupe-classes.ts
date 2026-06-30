/**
 * @domflax/patterns — Stage-2 compress pattern: `dedupe-classes`.
 *
 * Removes duplicate / fully-overridden class tokens that resolve to the same property where a
 * LATER token wins, leaving the minimal set of tokens with an IDENTICAL computed style. The
 * canonical case:
 *
 *   <p class="text-sm text-lg">…</p>   →   <p class="text-lg">…</p>
 *
 * Both `text-sm` and `text-lg` set `font-size`; resolution already made `text-lg` win, so the
 * computed `font-size` is `text-lg`'s value and `text-sm` contributes NOTHING to the final
 * computed style. The earlier token is pure noise and can be dropped without changing a pixel.
 *
 * How redundancy is detected (purely from the already-resolved, normalized computed StyleMap):
 *   • every declaration carries provenance — `origin` (the winning token) and `shadowed`
 *     (the tokens it overrode);
 *   • a class token is FULLY OVERRIDDEN iff it appears in some declaration's `shadowed` list but
 *     is NOT the winning `origin` of any declaration across ANY style condition (states/media/
 *     pseudo-element). Such a token can be deleted with zero effect on the computed style.
 *
 * Safety reasoning (why this is sound):
 *   • dropping a fully-overridden token cannot change the computed style by construction — its
 *     declarations are already shadowed in every condition;
 *   • we never touch a node whose class list is dynamic / spread-derived / opaque (we cannot
 *     splice tokens we cannot see), nor one carrying a ref / event handlers / dynamic children /
 *     raw `dangerouslySetInnerHTML` (hard opacity barriers);
 *   • we never touch a node that is the subject of a `>`/`+`/`~` combinator selector, and we drop
 *     ONLY tokens the resolver reports as `droppable` (referenced purely as a plain subject) — a
 *     class used as a descendant/compound/structural selector hook stays put even if its
 *     declarations are overridden (review-1: DF_SELECTOR_MEMBERSHIP).
 *
 * Realization: a single `setClassList` op carrying the MINIMAL StyleMap (identical declaration
 * values, with the redundant tokens' provenance pruned). A backend reverse-emits the minimal token
 * set from this map; because the values are untouched the computed style is byte-for-byte identical.
 */

import type {
  ConditionKey,
  CssProperty,
  DeepReadonly,
  Diagnostic,
  ElementLike,
  IRElement,
  IRNode,
  IRNodeId,
  MatchContext,
  MatchResult,
  NodeLike,
  Pattern,
  RewriteFactory,
  RewriteOpDraft,
  StyleBlock,
  StyleDecl,
  StyleMap,
  StyleOrigin,
} from '@domflax/core';

import {
  and,
  definePattern,
  hasDynamicChildren,
  hasDynamicClasses,
  hasEventHandlers,
  hasRef,
  isElement,
  not,
  targetedByCombinator,
  type Matcher,
} from '@domflax/pattern-kit';

/* ───────────────────────── local matchers (barriers the combinators don't expose) ───────────────────────── */

function elementOf(node: NodeLike): DeepReadonly<IRElement> | null {
  const n = node as DeepReadonly<IRNode>;
  return n.kind === 'element' ? (n as DeepReadonly<IRElement>) : null;
}

/** Element renders raw/`dangerouslySetInnerHTML` markup — a hard opacity barrier. */
const hasDangerousHtml: Matcher = (node) => elementOf(node)?.meta.hasDangerousHtml ?? false;

/** Element's class list is wholly dynamic/spread-derived → we cannot see or splice its tokens. */
const isOpaque: Matcher = (node, ctx) => ctx.isOpaque(node as ElementLike);

/* ───────────────────────── match predicate ───────────────────────── */

/**
 * Cheap node-local gate. The actual redundancy decision (which needs the computed provenance) lives
 * in `evaluate`; this only rules out nodes we must never rewrite the class list of.
 */
const isDedupeCandidate: Matcher = and(
  isElement(),
  not(hasRef),
  not(hasEventHandlers),
  not(hasDynamicChildren),
  not(hasDangerousHtml),
  not(hasDynamicClasses),
  not(isOpaque),
  not(targetedByCombinator),
);

/* ───────────────────────── provenance analysis ───────────────────────── */

/** A class token is droppable iff it was overridden everywhere AND never wins any declaration. */
function findRedundantClasses(computed: StyleMap): { winners: ReadonlySet<string>; shadowed: ReadonlySet<string> } {
  const winners = new Set<string>();
  const shadowed = new Set<string>();
  for (const block of computed.blocks.values()) {
    for (const decl of block.decls.values()) {
      if (decl.origin && decl.origin.kind === 'class') winners.add(decl.origin.className);
      for (const o of decl.shadowed ?? []) {
        if (o.kind === 'class') shadowed.add(o.className);
      }
    }
  }
  return { winners, shadowed };
}

/** Clone `sm`, pruning every `shadowed` provenance entry that references a dropped class token. */
function pruneShadowed(sm: StyleMap, drop: ReadonlySet<string>): StyleMap {
  const blocks = new Map<ConditionKey, StyleBlock>();
  for (const [key, block] of sm.blocks) {
    const decls = new Map<CssProperty, StyleDecl>();
    for (const [prop, decl] of block.decls) {
      const filtered = (decl.shadowed ?? []).filter(
        (o) => !(o.kind === 'class' && drop.has(o.className)),
      );
      const rest: StyleDecl = { ...decl };
      delete (rest as { shadowed?: readonly StyleOrigin[] }).shadowed;
      const next: StyleDecl = filtered.length > 0 ? { ...rest, shadowed: filtered } : rest;
      decls.set(prop, next);
    }
    blocks.set(key, { condition: block.condition, decls });
  }
  return { blocks };
}

/* ───────────────────────── the pattern ───────────────────────── */

/**
 * Stage-2 compress pattern: collapse a class list to the minimal token set that yields an identical
 * computed style, by dropping tokens whose declarations are fully overridden by later tokens.
 */
export const dedupeClasses: Pattern = definePattern({
  name: 'dedupe-classes',
  category: 'compress/dedupe-classes',
  safety: 1,
  doc: {
    title: 'Dedupe fully-overridden class tokens',
    summary:
      'Drops class tokens whose every declaration is overridden by a later token resolving to the ' +
      'same property; the surviving token set produces a byte-for-byte identical computed style.',
    before: '<p class="text-sm text-lg" />',
    after: '<p class="text-lg" />',
    safetyRationale:
      'A fully-overridden token contributes nothing to the computed style in any condition, so ' +
      'removing it changes no pixels. Dynamic/opaque class lists, ref/handler/dynamic-children/raw-' +
      'html barriers, combinator subjects, and selector-bound (non-droppable) tokens are excluded.',
  },
  evaluate(ctx: MatchContext, rw: RewriteFactory): MatchResult | null {
    const el = ctx.node;
    if (!isDedupeCandidate(el as unknown as NodeLike, ctx)) return null;

    const computed = ctx.computed();
    const { winners, shadowed } = findRedundantClasses(computed);

    const drop = new Set<string>();
    const diagnostics: Diagnostic[] = [];
    for (const cls of shadowed) {
      // A token that still wins SOME property elsewhere is not redundant — keep it.
      if (winners.has(cls)) continue;
      // Selector-membership safety: only drop a token referenced purely as a plain subject.
      if (!ctx.resolver.selectorUsage(cls).droppable) {
        diagnostics.push({
          code: 'DF_SELECTOR_MEMBERSHIP',
          severity: 'info',
          message: `kept overridden class '${cls}': it is referenced by a project selector`,
          nodeId: el.id as unknown as IRNodeId,
          pattern: 'dedupe-classes',
        });
        continue;
      }
      drop.add(cls);
    }

    if (drop.size === 0) return null;

    const minimal = pruneShadowed(computed, drop);
    const ops: readonly RewriteOpDraft[] = [rw.setClassList(el, minimal, true)];
    return diagnostics.length > 0 ? { ops, diagnostics } : { ops };
  },
});
