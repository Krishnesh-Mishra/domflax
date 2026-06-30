/**
 * @domflax/patterns — compress pattern: `dedupe-classes`.
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
 *     is NOT the winning `origin` of any declaration across ANY style condition. Such a token can
 *     be deleted with zero effect on the computed style.
 *
 * Authored with the declarative {@link pattern} API: `definePattern` auto-applies the compress safety guards — a dynamic or opaque class list
 * and combinator-subject selectors are excluded (a ref / event handler / dynamic child / dangerous
 * HTML never blocks a class-only rewrite); the `dropClasses` recipe returns the set of
 * fully-overridden, resolver-droppable tokens to delete (their `shadowed` provenance is pruned
 * automatically before the minimal class StyleMap is re-installed).
 */

import type { MatchContext, StyleMap } from '@domflax/core';

import { definePattern } from '@domflax/pattern-kit';

/* ───────────────────────── provenance analysis ───────────────────────── */

/** Winners (tokens that win some declaration) and shadowed (tokens overridden somewhere). */
function findRedundantClasses(computed: StyleMap): {
  winners: ReadonlySet<string>;
  shadowed: ReadonlySet<string>;
} {
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

/* ───────────────────────── the pattern ───────────────────────── */

/**
 * Collapse a class list to the minimal token set that yields an identical computed style, by
 * dropping tokens whose declarations are fully overridden by later tokens.
 */
export const dedupeClasses = definePattern({
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
      'A fully-overridden token contributes nothing to the computed style in any condition, so removing ' +
      'it changes no pixels — a class-only change. It is safe even on an element with a ref, event ' +
      'handler, dynamic child, or dangerouslySetInnerHTML — a className rewrite touches none of them; ' +
      'only a dynamic/opaque class list or a combinator-subject class is excluded, so no behaviour or ' +
      'project selector is disturbed.',
  },
  rewrite: {
    dropClasses(computed: StyleMap, ctx: MatchContext): Iterable<string> {
      const { winners, shadowed } = findRedundantClasses(computed);
      const drop = new Set<string>();
      for (const cls of shadowed) {
        // A token that still wins SOME property elsewhere is not redundant — keep it.
        if (winners.has(cls)) continue;
        // Selector-membership safety: only drop a token referenced purely as a plain subject.
        if (!ctx.resolver.selectorUsage(cls).droppable) continue;
        drop.add(cls);
      }
      return drop;
    },
  },
  test: {
    cases: [
      {
        // `text-sm` is fully overridden by `text-lg` (both set font-size + line-height). The resolver
        // records that shadowing in provenance and reports the Tailwind utility as droppable, so the
        // pattern drops `text-sm`; the reverse-emit then re-derives the minimal set (`text-lg`).
        before: '<p className="text-sm text-lg">Hi</p>',
        after: '<p className="text-lg">Hi</p>',
      },
    ],
    // Both tokens win a distinct property (no full override) → nothing to dedupe.
    noMatch: ['<p className="text-lg font-bold">Hi</p>'],
  },
});
