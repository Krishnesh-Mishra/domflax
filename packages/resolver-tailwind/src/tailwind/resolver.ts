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
import { BASE_CONDITION, conditionKey, tupleKey } from '@domflax/core';
import { normalizer } from '@domflax/pattern-kit';

import type { TailwindResolverConfig } from './config';
import type { BaseVocabEntry, CoverHost } from './cover';
import { buildBaseVocab, extractionTuples, sameTupleSet, tryExactCover } from './cover';
import { expandForEmit, synthesizeResidual } from './emit';
import { loadEngine } from './engine';
import type { ExtractedToken } from './extract';
import { extractToken } from './extract';
import { fnv1a } from './fingerprint';
import { parseSelector, unescapeClass } from './selector';
import { serializeCssNode } from './serialize';
import { buildStyleMap, shadowedBy } from './stylemap';
import type { TwEngine, TwGeneratedDecl, TwGeneratedRule } from './types';
import { splitVariantChain } from './variants';
import { DROPPABLE_USAGE, OPAQUE_USAGE, REBUILDABLE_VARIANT_USAGE } from './usage';

/**
 * Providers already warned about an unsupported Tailwind major, so the diagnostic is emitted ONCE per
 * distinct provider/version even when many resolvers (per-file caches, multiple runs) are constructed.
 */
const warnedUnsupported = new Set<string>();

class TailwindResolver implements StyleResolver {
  readonly id = 'tailwind';
  readonly provider: string;
  readonly fingerprint: string;
  /**
   * SAFETY (Layer 1): the detected Tailwind MAJOR when the project's version is one this resolver
   * cannot drive (v4+), else `null`. When set, {@link resolve} reports every token as unknown, so
   * downstream files are left unchanged (never mis-optimized). Exposed for diagnostics/tests.
   */
  readonly unsupportedMajor: number | null;

  readonly #engine: TwEngine | null;
  /** Per-token extraction cache (engine output is pure for a fixed config). */
  readonly #tokenCache = new Map<string, ExtractedToken>();
  /** Per-class-set forward-resolution cache. */
  readonly #resolveCache = new Map<string, ResolveResult>();
  /** Lazily built reverse index for the greedy {@link emit} fallback. */
  #reverseIndex: ReadonlyArray<readonly [string, ReadonlyMap<CssProperty, string>]> | null = null;
  /** Lazily built enumerated base vocabulary for the exact-cover engine (see ./cover). */
  #baseVocab: readonly BaseVocabEntry[] | null = null;
  /** Per-token variant-rebuildability verdicts (round-trip validated — see {@link #learnVariant}). */
  readonly #variantCache = new Map<string, boolean>();
  /** Learned condition-key → variant-chain prefixes (`'|:hover|'` → `'hover:'`), shortest wins. */
  readonly #prefixByCk = new Map<string, string>();

  constructor(config: TailwindResolverConfig = {}) {
    const loaded = loadEngine(config);
    this.#engine = loaded.engine;
    this.unsupportedMajor = loaded.unsupportedMajor;
    this.provider =
      config.provider ??
      (loaded.version ? `tailwindcss@${loaded.version}` : 'tailwindcss');
    const seed = JSON.stringify(config.config ?? {}) + (config.configPath ?? '');
    this.fingerprint = config.fingerprint ?? `${this.provider}/${fnv1a(seed)}`;

    // SAFETY (Layer 1): fail LOUDLY (once) when a v4+ project's real design system could NOT be
    // loaded (the v4 adapter fell through — e.g. `@tailwindcss/node` is missing). Every class then
    // resolves to `unknown` (below), so the per-element fail-safe leaves files unchanged instead of
    // unsafely flattening. A v4 project whose design system DID load has `unsupportedMajor === null`
    // and resolves normally — no warning.
    if (this.unsupportedMajor !== null && !warnedUnsupported.has(this.provider)) {
      warnedUnsupported.add(this.provider);
      // eslint-disable-next-line no-console
      console.warn(
        `domflax: detected Tailwind v${this.unsupportedMajor} (${this.provider}) but could not load its ` +
          `design system (is @tailwindcss/node installed?); classes cannot be resolved, so files are ` +
          `left unchanged to avoid unsafe edits.`,
      );
    }
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

  /**
   * VARIANT LEARNING (round-trip validated): a token with a variant chain (`hover:px-4`) is
   * REBUILDABLE iff (a) the full token resolves under exactly ONE non-base condition, (b) its bare
   * root utility (`px-4`) resolves BASE-only, and (c) the root's declarations re-keyed under that
   * condition equal the full token's declarations EXACTLY. Success also records the (shortest)
   * condition-key → chain mapping, which is what lets `emit` synthesize re-prefixed candidates for
   * that condition. Anything that fails any step (e.g. `before:` utilities, which inject `content`)
   * is NOT rebuildable and stays retained-verbatim.
   */
  #learnVariant(token: string): boolean {
    const cached = this.#variantCache.get(token);
    if (cached !== undefined) return cached;
    let ok = false;
    const split = splitVariantChain(token);
    if (split) {
      const norm = normalizer;
      const baseCk = String(conditionKey(BASE_CONDITION));
      const full = this.#extract(token);
      const fullTuples = extractionTuples(full, norm);
      const cks = new Set(full.blocks.map((b) => String(conditionKey(b.condition))));
      if (fullTuples && cks.size === 1 && !cks.has(baseCk)) {
        const ck = [...cks][0]!;
        const root = this.#extract(split.root);
        const rootCks = new Set(root.blocks.map((b) => String(conditionKey(b.condition))));
        if (
          root.produced &&
          !root.opaque &&
          rootCks.size === 1 &&
          rootCks.has(baseCk)
        ) {
          // Re-key the root's tuples under the full token's condition and demand exact equality.
          const rekeyed: string[] = [];
          for (const block of root.blocks) {
            for (const [prop, value, important] of block.decls) {
              for (const d of norm.normalizeDeclaration(prop, value, important)) {
                rekeyed.push(tupleKey(ck, String(d.property), String(d.value), d.important));
              }
            }
          }
          if (sameTupleSet(rekeyed, fullTuples)) {
            ok = true;
            const existing = this.#prefixByCk.get(ck);
            if (
              existing === undefined ||
              split.chain.length < existing.length ||
              (split.chain.length === existing.length && split.chain < existing)
            ) {
              this.#prefixByCk.set(ck, split.chain);
            }
          }
        }
      }
    }
    this.#variantCache.set(token, ok);
    return ok;
  }

  /** The {@link CoverHost} view of this resolver the exact-cover assembly drives (see ./cover). */
  #coverHost(norm: EmitContext['normalizer']): CoverHost {
    return {
      vocab: (): readonly BaseVocabEntry[] =>
        (this.#baseVocab ??= buildBaseVocab(this.#engine, normalizer)),
      extract: (token: string): ExtractedToken => this.#extract(token),
      prime: (tokens: readonly string[]): void => {
        try {
          this.#engine?.prime?.(tokens);
        } catch {
          /* a failing prime only means the pending candidates won't validate */
        }
      },
      prefixFor: (ck: string): string | undefined => this.#prefixByCk.get(ck),
      learn: (token: string): void => {
        this.#learnVariant(token);
      },
      resolveStyles: (classes: readonly string[]): StyleMap =>
        norm.normalizeStyleMap(this.resolve({ classes: [...classes] }).styles),
    };
  }

  emit(styles: StyleMap, ctx: EmitContext): EmitResult {
    const norm = ctx.normalizer ?? normalizer;
    const normalized = norm.normalizeStyleMap(styles);

    // Primary path: the provider-uniform minimal-string exact cover — enumerated vocabulary +
    // synthesized arbitrary-value candidates + variant-prefixed candidates + the element's own
    // droppable tokens, solved per condition block and verified by the re-resolve backstop.
    const cover = tryExactCover(this.#coverHost(norm), normalized, norm, ctx.sourceTokens);
    if (cover) return cover;

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
    // must be a plain (non-opaque) utility contributing ONLY base-condition declarations. A
    // VARIANT-BOUND utility whose exact effect round-trips ({@link #learnVariant}) is surfaced as
    // REBUILDABLE — droppable only under reverse-emit's mandatory equality backstop. Everything
    // else (opaque combinator/at-rule utilities, unvalidated variants) is kept verbatim.
    const ex = this.#extract(token);
    if (!ex.produced || ex.opaque) return OPAQUE_USAGE;
    const baseOnly =
      ex.blocks.length > 0 &&
      ex.blocks.every((b) => conditionKey(b.condition) === conditionKey(BASE_CONDITION));
    if (baseOnly) return DROPPABLE_USAGE;
    if (this.#learnVariant(token)) return REBUILDABLE_VARIANT_USAGE;
    return OPAQUE_USAGE;
  }
}

/** Factory: build a Tailwind-backed {@link StyleResolver}. */
export function createTailwindResolver(config?: TailwindResolverConfig): StyleResolver {
  return new TailwindResolver(config);
}
