/**
 * @domflax/resolver-tailwind — the exact-cover assembly (vocabulary + per-block solve).
 *
 * The provider-uniform compress engine (`@domflax/core`'s {@link minStringCover}) needs a candidate
 * vocabulary per target. This module builds it in three layers, then solves PER CONDITION BLOCK:
 *
 *   1. ENUMERATED — every base-condition, plain-subject utility from the engine's class list
 *      ({@link buildBaseVocab}); for a NON-BASE block, entries whose declarations exactly match the
 *      block's are RE-PREFIXED with the block's learned variant chain (`hover:` + `p-4`).
 *   2. SYNTHESIZED — arbitrary-value `stem-[value]` proposals for the block's exact values
 *      (see `./synthesize`), likewise re-prefixed for variant blocks.
 *   3. SOURCE TOKENS — the element's own droppable tokens ({@link EmitContext.sourceTokens}),
 *      guaranteeing feasibility (the original tokens can always re-cover their own contribution).
 *
 * VALIDATION: every prefixed/synthesized candidate is ROUND-TRIPPED through the real engine before
 * admission — its resolved tuples must equal the intended tuples EXACTLY (v4 misses are batch-primed
 * once via the bridge). Because no candidate spans two conditions, the exact cover decomposes into
 * independent per-block solves (each within the DP's universe bound). Finally the UNION of all
 * chosen tokens is re-resolved and asserted tuple-equal to the whole target (the mandatory
 * correctness backstop) — any mismatch discards the cover and the caller uses its greedy fallback.
 */

import type { CssProperty, EmitResult, StyleMap, StyleNormalizer } from '@domflax/core';
import {
  BASE_CONDITION,
  conditionKey,
  minStringCover,
  styleMapTuples,
  tupleKey,
} from '@domflax/core';
import type { CoverClass } from '@domflax/core';

import type { ExtractedToken } from './extract';
import { parseSelector, unescapeClass } from './selector';
import { synthesizeProposals } from './synthesize';
import type { TwEngine, TwGeneratedDecl, TwGeneratedRule } from './types';

/* ───────────────────────── enumerated base vocabulary ───────────────────────── */

/** One enumerable utility: token, BASE-condition tuples, and its raw normalized decl triples. */
export interface BaseVocabEntry {
  readonly token: string;
  readonly tuples: readonly string[];
  /** `[property, canonicalValue, important]` — used to re-key the entry under a variant chain. */
  readonly decls: ReadonlyArray<readonly [string, string, boolean]>;
}

/**
 * Build the enumerated vocabulary from a SINGLE engine `generate` over the class list: every
 * base-condition, plain-subject utility mapped to its normalized-longhand declaration set. Variant /
 * combinator / pseudo utilities are excluded (their effect is not the element's own base box).
 */
export function buildBaseVocab(engine: TwEngine | null, norm: StyleNormalizer): BaseVocabEntry[] {
  const baseCk = String(conditionKey(BASE_CONDITION));
  const out: BaseVocabEntry[] = [];
  if (!engine) return out;
  try {
    const classes = engine.context.getClassList().filter((c): c is string => typeof c === 'string');
    const nodes = engine.generate(classes);
    for (const node of nodes) {
      if (node.type !== 'rule') continue;
      const rule = node as TwGeneratedRule;
      const parsed = parseSelector(rule.selector);
      if (parsed.kind !== 'simple' || parsed.states.length > 0 || parsed.pseudoElement !== '') {
        continue; // BASE-only, own-box utilities only
      }
      const className = unescapeClass(rule.selector);
      if (className === null) continue;
      const tuples: string[] = [];
      const decls: Array<readonly [string, string, boolean]> = [];
      const seen = new Set<string>();
      for (const child of rule.nodes ?? []) {
        if (child.type !== 'decl') continue;
        const d = child as TwGeneratedDecl;
        if (typeof d.value !== 'string') continue;
        for (const decl of norm.normalizeDeclaration(d.prop, d.value, d.important === true)) {
          const k = tupleKey(baseCk, String(decl.property), String(decl.value), decl.important);
          if (!seen.has(k)) {
            seen.add(k);
            tuples.push(k);
            decls.push([String(decl.property), String(decl.value), decl.important] as const);
          }
        }
      }
      if (tuples.length > 0) out.push({ token: className, tuples, decls });
    }
  } catch {
    /* leave vocab empty on failure — the cover degrades to the greedy fallback */
  }
  return out;
}

/* ───────────────────────── extraction → tuple helpers ───────────────────────── */

/**
 * The full normalized tuple set of an extraction (real condition keys), or `null` when the token is
 * unusable as a cover candidate (unresolvable, opaque, or declaration-free).
 */
export function extractionTuples(ex: ExtractedToken, norm: StyleNormalizer): string[] | null {
  if (!ex.produced || ex.opaque || ex.blocks.length === 0) return null;
  const out = new Set<string>();
  for (const block of ex.blocks) {
    const ck = String(conditionKey(block.condition));
    for (const [prop, value, important] of block.decls) {
      for (const decl of norm.normalizeDeclaration(prop, value, important)) {
        out.add(tupleKey(ck, String(decl.property), String(decl.value), decl.important));
      }
    }
  }
  return out.size > 0 ? [...out] : null;
}

/** Set equality of two tuple lists. */
export function sameTupleSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const t of sa) if (!sb.has(t)) return false;
  return true;
}

/* ───────────────────────── the per-block exact cover ───────────────────────── */

/** Everything the cover solver needs from the resolver (kept as callbacks to stay testable). */
export interface CoverHost {
  vocab(): readonly BaseVocabEntry[];
  extract(token: string): ExtractedToken;
  /** Warm the engine for candidates outside the enumerable list (v4 snapshot batching; v3 no-op). */
  prime(tokens: readonly string[]): void;
  /** The validated variant chain for a condition key, if one has been learned. */
  prefixFor(ck: string): string | undefined;
  /** Learn (validate + record) a token's variant chain, if it has one. */
  learn(token: string): void;
  resolveStyles(classes: readonly string[]): StyleMap;
}

interface PendingCandidate {
  readonly token: string;
  readonly tuples: readonly string[];
}

/**
 * Solve the minimal-string exact cover of `normalized` (an already-normalized target StyleMap).
 * Returns the verified {@link EmitResult}, or `null` so the caller falls back to its greedy emit.
 */
export function tryExactCover(
  host: CoverHost,
  normalized: StyleMap,
  norm: StyleNormalizer,
  sourceTokens: readonly string[] | undefined,
): EmitResult | null {
  const universe = styleMapTuples(normalized, norm);
  if (universe.length === 0) return { classes: [], exact: true, warnings: [] };

  // Variant chains are learned from real tokens; the element's own tokens are the best teachers.
  for (const t of sourceTokens ?? []) host.learn(t);

  const baseCk = String(conditionKey(BASE_CONDITION));

  interface BlockPlan {
    readonly ck: string;
    readonly tuples: readonly string[];
    readonly candidates: CoverClass[];
    readonly pending: PendingCandidate[];
  }

  const plans: BlockPlan[] = [];
  for (const [ckKey, block] of normalized.blocks) {
    const ck = String(ckKey);
    const tuples: string[] = [];
    for (const [prop, decl] of block.decls) {
      tuples.push(tupleKey(ck, String(prop), String(decl.value), decl.important));
    }
    const plan: BlockPlan = { ck, tuples, candidates: [], pending: [] };
    const proposals = synthesizeProposals(block.decls);

    if (ck === baseCk) {
      for (const e of host.vocab()) plan.candidates.push({ token: e.token, tuples: e.tuples });
      for (const p of proposals) {
        plan.pending.push({
          token: p.token,
          tuples: p.decls.map(([prop, value]) => tupleKey(ck, prop, value, false)),
        });
      }
    } else {
      // VARIANT block: candidates are enumerated + synthesized utilities RE-PREFIXED with this
      // block's exact learned chain. An unlearned chain makes the whole target unreachable → the
      // caller's greedy fallback (which retains variant tokens verbatim) handles it.
      const chain = host.prefixFor(ck);
      if (chain === undefined) return null;
      for (const e of host.vocab()) {
        if (e.decls.length === 0 || e.decls.length > block.decls.size) continue;
        let fits = true;
        for (const [prop, value, important] of e.decls) {
          const d = block.decls.get(prop as CssProperty);
          if (!d || String(d.value) !== value || d.important !== important) {
            fits = false;
            break;
          }
        }
        if (!fits) continue;
        plan.pending.push({
          token: chain + e.token,
          tuples: e.decls.map(([prop, value, important]) => tupleKey(ck, prop, value, important)),
        });
      }
      for (const p of proposals) {
        plan.pending.push({
          token: chain + p.token,
          tuples: p.decls.map(([prop, value]) => tupleKey(ck, prop, value, false)),
        });
      }
    }
    plans.push(plan);
  }

  // SOURCE TOKENS: each is attributed to the single condition block its extraction lives in — its
  // tuples come from the real engine, so it needs no further validation. (A token spanning several
  // conditions cannot join a per-block solve and is skipped; retained-verbatim behaviour covers it.)
  for (const t of new Set(sourceTokens ?? [])) {
    const ex = host.extract(t);
    const tuples = extractionTuples(ex, norm);
    if (!tuples) continue;
    const cks = new Set(ex.blocks.map((b) => String(conditionKey(b.condition))));
    if (cks.size !== 1) continue;
    const only = [...cks][0];
    const plan = plans.find((pl) => pl.ck === only);
    if (plan) plan.candidates.push({ token: t, tuples });
  }

  // ROUND-TRIP VALIDATION of every prefixed/synthesized candidate (batch-primed once for v4): its
  // real resolved tuples must equal the intended tuples EXACTLY, else it is discarded.
  const pendingTokens = [...new Set(plans.flatMap((pl) => pl.pending.map((p) => p.token)))];
  if (pendingTokens.length > 0) host.prime(pendingTokens);
  for (const plan of plans) {
    for (const p of plan.pending) {
      const actual = extractionTuples(host.extract(p.token), norm);
      if (!actual || !sameTupleSet(actual, p.tuples)) continue;
      plan.candidates.push({ token: p.token, tuples: p.tuples });
    }
  }

  // Independent per-block DP solves (no candidate spans two conditions).
  const chosen = new Set<string>();
  for (const plan of plans) {
    const res = minStringCover(plan.tuples, plan.candidates);
    if (!res || res.length === 0) return null;
    for (const t of res) chosen.add(t);
  }
  const classes = [...chosen].sort();

  // MANDATORY CORRECTNESS BACKSTOP: re-resolve the union and require exact tuple equality with the
  // whole target — a set that does not reproduce it is NEVER emitted.
  const reTuples = new Set(styleMapTuples(host.resolveStyles(classes), norm));
  const want = new Set(universe);
  if (reTuples.size !== want.size) return null;
  for (const t of want) if (!reTuples.has(t)) return null;
  return { classes, exact: true, warnings: [] };
}
