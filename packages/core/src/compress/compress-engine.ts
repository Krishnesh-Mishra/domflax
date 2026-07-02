/**
 * @domflax/core — the general COMPRESS ENGINE: a minimal-string exact-cover solver.
 *
 * ## What it replaces
 *
 * The hand-written compress patterns (padding/margin/inset/size/gap/place/border/overflow/…-shorthand
 * and dedupe-classes) each recognised ONE shorthand shape and folded it. This module subsumes them
 * ALL with a SINGLE, provider-uniform algorithm: given an element's target computed style, find the
 * class set that reproduces it EXACTLY with the SHORTEST total `class="…"` string, searching the whole
 * vocabulary (every Tailwind utility AND the project's custom-CSS classes at once).
 *
 * ## The algorithm (per element, per style-condition — all folded into one solve)
 *
 * Given a normalized target StyleMap `U`:
 *   1. UNIVERSE = the set of `(conditionKey, property, value, important)` tuples in `U`
 *      (a `tupleKey` per {@link tupleKey}).
 *   2. CANDIDATES = the vocabulary classes whose FULL normalized-longhand declaration set is a SUBSET
 *      of `U` (never introduces a declaration `U` does not already contain). The caller feeds the
 *      vocabulary; the element's own droppable tokens are part of it, guaranteeing feasibility and the
 *      "never worse than the original" property.
 *   3. COST(class) = token length + 1 (the token plus its joining space) — so minimizing total cost
 *      minimizes the rendered `class="…"` byte length exactly.
 *   4. MIN-COST EXACT COVER via bitmask DP over `U`'s tuples: `dp[coveredMask]` = least cost reaching
 *      that coverage; each transition adds one candidate's mask. Because every candidate AGREES with
 *      `U` on every tuple it sets, ANY full cover reproduces `U` at the tuple level.
 *   5. `|U|` is BOUNDED ({@link DEFAULT_MAX_UNIVERSE}); a larger condition-block returns `null` so the
 *      caller falls back to its greedy emit for that element.
 *
 * The **correctness backstop** (re-resolve the chosen set and assert it equals `U` exactly) lives in
 * each resolver's `emit` — it owns the forward `resolve`, and running the check there keeps this core
 * helper pure and provider-agnostic. A chosen set that fails the backstop is discarded and the greedy
 * emit is used instead, so a set that does not reproduce `U` is NEVER emitted.
 */

import type { StyleMap, StyleNormalizer } from '../ir/types';

/** Field separator for {@link tupleKey} — a control char that never appears in CSS text. */
const SEP = '';

/**
 * The canonical key for one normalized declaration under one style condition: the atomic unit both the
 * target universe and every vocabulary class are expressed in. Equal keys ⇔ the SAME declaration.
 */
export function tupleKey(
  condition: string,
  property: string,
  value: string,
  important: boolean,
): string {
  return `${condition}${SEP}${property}${SEP}${value}${SEP}${important ? '1' : '0'}`;
}

/**
 * Flatten a StyleMap into its set of {@link tupleKey}s (normalizing first). This is how BOTH the target
 * universe and each vocabulary class's declarations are lowered, so a class's tuples can be tested for
 * subset-membership in the universe by plain string equality.
 */
export function styleMapTuples(map: StyleMap, norm: StyleNormalizer): string[] {
  const out: string[] = [];
  const normalized = norm.normalizeStyleMap(map);
  for (const [ck, block] of normalized.blocks) {
    for (const [prop, decl] of block.decls) {
      out.push(tupleKey(String(ck), String(prop), String(decl.value), decl.important));
    }
  }
  return out;
}

/** One vocabulary entry: a class token and the {@link tupleKey}s its full declaration set produces. */
export interface CoverClass {
  readonly token: string;
  readonly tuples: readonly string[];
}

export interface MinCoverOptions {
  /** Upper bound on `|U|`; above it the DP is skipped (`null`) so the caller uses its greedy emit. */
  readonly maxUniverse?: number;
}

/**
 * The largest universe the bitmask DP will solve. 20 tuples ⇒ a `2^20` (~1M) DP table, comfortably
 * fast and bounded in memory; a heavier element (rare) falls back to the resolver's greedy emit.
 */
export const DEFAULT_MAX_UNIVERSE = 20;

/**
 * Solve the minimal-string exact cover of `universe` using `vocabulary`.
 *
 * Returns the chosen class tokens (sorted, de-duplicated) whose union reproduces `universe` EXACTLY at
 * least total string cost, or `null` when there is no exact cover OR the universe exceeds the bound (in
 * both cases the caller falls back to its greedy emit). An empty universe yields `[]`.
 *
 * Pure and provider-agnostic: the caller performs the re-resolve correctness backstop.
 */
export function minStringCover(
  universe: readonly string[],
  vocabulary: Iterable<CoverClass>,
  options: MinCoverOptions = {},
): readonly string[] | null {
  const uniq = [...new Set(universe)];
  if (uniq.length === 0) return [];
  const n = uniq.length;
  const max = options.maxUniverse ?? DEFAULT_MAX_UNIVERSE;
  if (n > max) return null;

  const bitOf = new Map<string, number>();
  uniq.forEach((t, i) => bitOf.set(t, i));

  interface Cand {
    readonly token: string;
    readonly mask: number;
    readonly cost: number;
  }
  // A candidate is any vocabulary class ALL of whose tuples lie in the universe (a subset fit). Two
  // classes with the same coverage mask are collapsed to the cheaper (shorter, then lexicographically
  // smaller) one — an equal-mask class can never help beyond the cheapest representative.
  const byMask = new Map<number, Cand>();
  for (const entry of vocabulary) {
    if (entry.tuples.length === 0) continue;
    let mask = 0;
    let ok = true;
    for (const t of entry.tuples) {
      const b = bitOf.get(t);
      if (b === undefined) {
        ok = false;
        break;
      }
      mask |= 1 << b;
    }
    if (!ok || mask === 0) continue;
    const cost = entry.token.length + 1;
    const prev = byMask.get(mask);
    if (!prev || cost < prev.cost || (cost === prev.cost && entry.token < prev.token)) {
      byMask.set(mask, { token: entry.token, mask, cost });
    }
  }
  const cands = [...byMask.values()];
  if (cands.length === 0) return null;

  const full = (1 << n) - 1;

  // For each universe bit, the candidates that cover it — the DP only ever expands the lowest still-
  // uncovered bit, which bounds the branching without missing any optimum.
  const byBit: number[][] = Array.from({ length: n }, () => []);
  cands.forEach((c, ci) => {
    for (let b = 0; b < n; b += 1) if (c.mask & (1 << b)) byBit[b]!.push(ci);
  });

  const size = full + 1;
  const dp = new Float64Array(size).fill(Infinity);
  const fromCand = new Int32Array(size).fill(-1);
  const fromMask = new Int32Array(size).fill(-1);
  dp[0] = 0;

  for (let mask = 0; mask < full; mask += 1) {
    const cur = dp[mask]!;
    if (!Number.isFinite(cur)) continue;
    // Lowest uncovered bit — every optimal cover must include a candidate covering it.
    let b = 0;
    while (b < n && mask & (1 << b)) b += 1;
    for (const ci of byBit[b]!) {
      const c = cands[ci]!;
      const nm = mask | c.mask;
      const cost = cur + c.cost;
      if (cost < dp[nm]!) {
        dp[nm] = cost;
        fromCand[nm] = ci;
        fromMask[nm] = mask;
      }
    }
  }

  if (!Number.isFinite(dp[full]!)) return null;

  const chosen: string[] = [];
  let m = full;
  while (m !== 0) {
    const ci = fromCand[m]!;
    if (ci < 0) return null;
    chosen.push(cands[ci]!.token);
    m = fromMask[m]!;
  }
  return [...new Set(chosen)].sort();
}
