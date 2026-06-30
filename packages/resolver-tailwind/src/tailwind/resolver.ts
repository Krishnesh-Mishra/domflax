/**
 * @domflax/resolver-tailwind — the {@link StyleResolver} implementation + public factory.
 */

import type {
  CssProperty,
  EmitContext,
  EmitResult,
  OpaqueToken,
  ResolveInput,
  ResolveResult,
  SelectorUsage,
  StyleCondition,
  StyleDecl,
  StyleMap,
  StyleOrigin,
  StyleResolver,
} from '@domflax/core';
import { BASE_CONDITION, conditionKey } from '@domflax/core';
import { normalizer } from '@domflax/pattern-kit';

import type { TailwindResolverConfig } from './config';
import { expandForEmit, synthesizeResidual } from './emit';
import { loadEngine } from './engine';
import type { ExtractedToken } from './extract';
import { extractToken } from './extract';
import { fnv1a } from './fingerprint';
import { parseSelector, unescapeClass } from './selector';
import { serializeCssNode } from './serialize';
import { buildStyleMap, shadowedBy } from './stylemap';
import type { TwEngine, TwGeneratedDecl, TwGeneratedRule } from './types';
import { DROPPABLE_USAGE, OPAQUE_USAGE } from './usage';

class TailwindResolver implements StyleResolver {
  readonly id = 'tailwind';
  readonly provider: string;
  readonly fingerprint: string;

  readonly #engine: TwEngine | null;
  /** Per-token extraction cache (engine output is pure for a fixed config). */
  readonly #tokenCache = new Map<string, ExtractedToken>();
  /** Per-class-set forward-resolution cache. */
  readonly #resolveCache = new Map<string, ResolveResult>();
  /** Lazily built reverse index for {@link emit}. */
  #reverseIndex: ReadonlyArray<readonly [string, ReadonlyMap<CssProperty, string>]> | null = null;

  constructor(config: TailwindResolverConfig = {}) {
    this.#engine = loadEngine(config);
    this.provider =
      config.provider ?? (this.#engine ? `tailwindcss@${this.#engine.version}` : 'tailwindcss');
    const seed = JSON.stringify(config.config ?? {}) + (config.configPath ?? '');
    this.fingerprint = config.fingerprint ?? `${this.provider}/${fnv1a(seed)}`;
  }

  /** Engine-backed, cached single-token extraction. */
  #extract(token: string): ExtractedToken {
    const cached = this.#tokenCache.get(token);
    if (cached) return cached;
    let result: ExtractedToken;
    if (!this.#engine) {
      result = { blocks: [], produced: false };
    } else {
      try {
        result = extractToken(token, this.#engine.generate([token]));
      } catch {
        result = { blocks: [], produced: false };
      }
    }
    this.#tokenCache.set(token, result);
    return result;
  }

  owns(token: string): boolean {
    if (token.length === 0) return false;
    return this.#extract(token).produced;
  }

  resolve(input: ResolveInput): ResolveResult {
    const key = JSON.stringify(input.classes);
    const cached = this.#resolveCache.get(key);
    if (cached) return cached;

    // condition-key → { condition, longhand decls }. Iterating classes in source order means later
    // utilities overwrite earlier ones on the same property (equal-specificity cascade).
    const blockMaps = new Map<
      string,
      { condition: StyleCondition; decls: Map<CssProperty, StyleDecl> }
    >();
    const resolved: string[] = [];
    const unknown: string[] = [];
    const opaque: OpaqueToken[] = [];

    input.classes.forEach((token, tokenIndex) => {
      const extracted = this.#extract(token);
      if (!extracted.produced) {
        unknown.push(token);
        return;
      }
      if (extracted.opaque) opaque.push(extracted.opaque);
      if (extracted.blocks.length === 0) return; // produced only opaque rules

      const origin: StyleOrigin = { kind: 'class', tokenIndex, className: token };
      let contributed = false;
      for (const block of extracted.blocks) {
        const ck = conditionKey(block.condition);
        let bucket = blockMaps.get(ck);
        if (!bucket) {
          bucket = { condition: block.condition, decls: new Map() };
          blockMaps.set(ck, bucket);
        }
        for (const [prop, value, important] of block.decls) {
          for (const decl of normalizer.normalizeDeclaration(prop, value, important)) {
            // Record provenance: a LATER token on the same property shadows the earlier one. The
            // overridden origin (plus anything it already shadowed) is carried in `shadowed`, which
            // is exactly what the `dedupe-classes` pattern reads to find fully-overridden tokens.
            // This only enriches decl metadata — the resolved VALUES are unchanged.
            const prev = bucket.decls.get(decl.property);
            const shadowed = prev ? shadowedBy(prev) : undefined;
            bucket.decls.set(decl.property, shadowed ? { ...decl, origin, shadowed } : { ...decl, origin });
            contributed = true;
          }
        }
      }
      if (contributed) resolved.push(token);
    });

    const result: ResolveResult = {
      styles: buildStyleMap(blockMaps),
      resolved,
      unknown,
      opaque,
      warnings: [],
    };
    this.#resolveCache.set(key, result);
    return result;
  }

  /**
   * Lazily build the reverse index from the engine's own enumerable class list. Each indexable
   * utility maps to its NORMALIZED BASE longhand declarations (property → canonical value). Utilities
   * with variant conditions, combinator selectors, or no BASE declarations are skipped. Sorted by
   * declaration count (desc) so greedier (shorthand-like) utilities are tried first.
   */
  #buildReverseIndex(): ReadonlyArray<readonly [string, ReadonlyMap<CssProperty, string>]> {
    if (this.#reverseIndex) return this.#reverseIndex;
    const index: Array<readonly [string, Map<CssProperty, string>]> = [];
    if (this.#engine) {
      try {
        const classes = this.#engine.context
          .getClassList()
          .filter((c): c is string => typeof c === 'string');
        const nodes = this.#engine.generate(classes);
        // Re-extract per class would be costly; instead group decls by their (single) class selector.
        for (const node of nodes) {
          if (node.type !== 'rule') continue; // skip @media / @keyframes wrappers (⇒ variants only)
          const rule = node as TwGeneratedRule;
          const parsed = parseSelector(rule.selector);
          if (parsed.kind !== 'simple' || parsed.states.length > 0 || parsed.pseudoElement !== '') {
            continue; // BASE-only
          }
          const className = unescapeClass(rule.selector);
          if (className === null) continue;
          const decls = new Map<CssProperty, string>();
          for (const child of rule.nodes ?? []) {
            if (child.type !== 'decl') continue;
            const d = child as TwGeneratedDecl;
            if (typeof d.value !== 'string') continue;
            for (const decl of normalizer.normalizeDeclaration(d.prop, d.value, d.important === true)) {
              decls.set(decl.property, String(decl.value));
            }
          }
          if (decls.size > 0) index.push([className, decls]);
        }
      } catch {
        /* leave index empty on failure — emit degrades to a no-op */
      }
    }
    index.sort((a, b) => b[1].size - a[1].size || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    this.#reverseIndex = index;
    return index;
  }

  emit(styles: StyleMap, ctx: EmitContext): EmitResult {
    const norm = ctx.normalizer ?? normalizer;
    const normalized = norm.normalizeStyleMap(styles);
    const base = normalized.blocks.get(conditionKey(BASE_CONDITION));
    if (!base || base.decls.size === 0) return { classes: [], exact: true, warnings: [] };

    // Only the BASE block is reverse-synthesized (see module LIMITATION). Any non-base condition
    // present in the target means we cannot be exact.
    const hasNonBase = normalized.blocks.size > 1;

    // The target longhand map. The IR's compress passes hand us SHORTHAND properties (`padding`,
    // `margin`, `inset`, `inset-block`, `inset-inline`, `size`); we expand them to the same longhand
    // basis the reverse index is keyed on, so a single shorthand utility (`p-4`, `size-4`, `inset-0`)
    // can cover them.
    const target = new Map<CssProperty, string>();
    for (const [prop, decl] of base.decls) {
      for (const [lp, lv] of expandForEmit(norm, String(prop), String(decl.value), decl.important)) {
        target.set(lp, lv);
      }
    }

    // Keep only utilities every one of whose declarations matches the target (an exact-fit subset);
    // emitting a utility that sets an unwanted property/value would change the computed style.
    const candidates: Array<readonly [string, ReadonlyMap<CssProperty, string>]> = [];
    for (const entry of this.#buildReverseIndex()) {
      const [, declMap] = entry;
      if (declMap.size === 0 || declMap.size > target.size) continue;
      let fits = true;
      for (const [prop, value] of declMap) {
        if (target.get(prop) !== value) {
          fits = false;
          break;
        }
      }
      if (fits) candidates.push(entry);
    }

    // Greedy set-cover: repeatedly take the candidate covering the MOST still-needed declarations,
    // so a shorthand (`p-4`, 4 decls) beats `px-4`+`py-4`. Ties break toward the tighter decl-set
    // then lexicographically, for deterministic output.
    const remaining = new Map(target);
    const classes: string[] = [];
    while (remaining.size > 0) {
      let best: readonly [string, ReadonlyMap<CssProperty, string>] | null = null;
      let bestCover = 0;
      for (const entry of candidates) {
        const [token, declMap] = entry;
        let cover = 0;
        for (const prop of declMap.keys()) if (remaining.has(prop)) cover += 1;
        if (cover === 0) continue;
        const better =
          best === null ||
          cover > bestCover ||
          (cover === bestCover && declMap.size < best[1].size) ||
          (cover === bestCover && declMap.size === best[1].size && token < best[0]);
        if (better) {
          best = entry;
          bestCover = cover;
        }
      }
      if (!best) break; // nothing covers any still-needed declaration → residual
      classes.push(best[0]);
      for (const prop of best[1].keys()) remaining.delete(prop);
    }

    const exact = remaining.size === 0 && !hasNonBase;
    if (remaining.size === 0) return { classes, exact, warnings: [] };

    // Surface what no utility could cover as a residual synthetic (never thrown, never invented).
    const residual = synthesizeResidual(remaining, ctx);
    return residual
      ? { classes, residual, exact, warnings: [] }
      : { classes, exact, warnings: [] };
  }

  /**
   * Generate a CSS stylesheet that defines `classes`, so a verifier can render a subtree with the
   * real Tailwind styling applied. Backed by the same engine `resolve` uses (`generate(candidates)`),
   * serialized to plain CSS. Returns `''` when the engine is unavailable or generates nothing.
   */
  cssFor(classes: readonly string[]): string {
    if (!this.#engine) return '';
    const tokens = [...new Set(classes)].filter((c) => c.length > 0);
    if (tokens.length === 0) return '';
    try {
      return this.#engine
        .generate(tokens)
        .map((n) => serializeCssNode(n))
        .filter((s) => s.length > 0)
        .join('\n');
    } catch {
      return '';
    }
  }

  selectorUsage(token: string): SelectorUsage {
    // No project selector graph yet, so we cannot know how a CUSTOM (non-Tailwind) class is
    // referenced — treat it as load-bearing (preserved verbatim). A resolver-OWNED utility, by
    // contrast, is safe to drop/replace iff its whole effect is reproducible from `computed`: it
    // must be a plain (non-opaque) utility contributing ONLY base-condition declarations. Opaque
    // (combinator/at-rule) and variant-bound utilities are kept, because `emit` cannot rebuild them.
    const ex = this.#extract(token);
    if (!ex.produced || ex.opaque) return OPAQUE_USAGE;
    const baseOnly =
      ex.blocks.length > 0 &&
      ex.blocks.every((b) => conditionKey(b.condition) === conditionKey(BASE_CONDITION));
    if (!baseOnly) return OPAQUE_USAGE;
    return DROPPABLE_USAGE;
  }
}

/** Factory: build a Tailwind-backed {@link StyleResolver}. */
export function createTailwindResolver(config?: TailwindResolverConfig): StyleResolver {
  return new TailwindResolver(config);
}
