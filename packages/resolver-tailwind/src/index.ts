/**
 * @domflax/resolver-tailwind — Tailwind-aware {@link StyleResolver}.
 *
 * TYPED STUB (Stage N). The forward (`resolve`) and reverse (`emit`) directions require a real
 * Tailwind engine — class-name → utility expansion, theme/config introspection, and reverse
 * synthesis of utilities from a normalized {@link StyleMap}. Those land later and currently throw
 * `NotImplemented`. The lightweight, honest parts (ownership probing, selector-usage defaults,
 * identity/fingerprint) are implemented for real so the resolver can be wired into the pipeline
 * and typechecks under strict + verbatimModuleSyntax today.
 *
 * Future dep (NOT in package.json until the engine lands): tailwindcss.
 */

import type {
  EmitContext,
  EmitResult,
  ResolveInput,
  ResolveResult,
  SelectorUsage,
  StyleMap,
  StyleResolver,
} from '@domflax/core';

/** Construction-time configuration for {@link createTailwindResolver}. */
export interface TailwindResolverConfig {
  /** Provider tag surfaced via {@link StyleResolver.provider}. Defaults to a pinned version. */
  readonly provider?: string;
  /**
   * Cache-busting fingerprint. Real impl derives this from the resolved Tailwind theme/config and
   * any source CSS; the stub accepts a caller-supplied value or falls back to the provider tag.
   */
  readonly fingerprint?: string;
  /**
   * Extra known utility prefixes treated as owned by this resolver, in addition to the built-in
   * heuristics. Purely a forward-compatibility hook for the stub.
   */
  readonly extraPrefixes?: readonly string[];
}

const DEFAULT_PROVIDER = 'tailwindcss@4.0.0';

/**
 * A conservative, never-droppable {@link SelectorUsage}. Until the real selector graph exists we
 * must assume a class could be referenced in any unsafe position, so nothing is safe to rewrite.
 */
const OPAQUE_USAGE: SelectorUsage = {
  asSubject: true,
  asAncestor: true,
  asCompound: true,
  asSibling: true,
  asHasArgument: true,
  asStructural: true,
  droppable: false,
};

/**
 * Cheap syntactic heuristic for whether a class token looks like a Tailwind utility. This is a
 * best-effort prefilter (the real engine consults the generated utility set); it intentionally
 * errs toward `false` for clearly non-Tailwind tokens.
 */
function looksLikeTailwindUtility(token: string, extraPrefixes: readonly string[]): boolean {
  if (token.length === 0) return false;

  // Strip variant chain (e.g. `hover:md:`) and arbitrary-property/value brackets.
  const lastColon = token.lastIndexOf(':');
  const base = lastColon === -1 ? token : token.slice(lastColon + 1);
  if (base.length === 0) return false;

  for (const prefix of extraPrefixes) {
    if (base === prefix || base.startsWith(`${prefix}-`)) return true;
  }

  // Arbitrary properties: `[mask-type:luminance]`.
  if (base.startsWith('[') && base.endsWith(']')) return true;

  // Negative utilities: `-mt-4`.
  return /^-?[a-z][a-z0-9]*(-[a-z0-9[\]./%#,()'"+*_-]+)*$/.test(base);
}

class TailwindResolver implements StyleResolver {
  readonly id = 'tailwind';
  readonly provider: string;
  readonly fingerprint: string;
  readonly #extraPrefixes: readonly string[];

  constructor(config: TailwindResolverConfig = {}) {
    this.provider = config.provider ?? DEFAULT_PROVIDER;
    this.fingerprint = config.fingerprint ?? this.provider;
    this.#extraPrefixes = config.extraPrefixes ?? [];
  }

  owns(token: string): boolean {
    return looksLikeTailwindUtility(token, this.#extraPrefixes);
  }

  resolve(_input: ResolveInput): ResolveResult {
    throw new Error('NotImplemented: TailwindResolver.resolve (forward utility expansion) lands in Stage N');
  }

  emit(_styles: StyleMap, _ctx: EmitContext): EmitResult {
    throw new Error('NotImplemented: TailwindResolver.emit (reverse utility synthesis) lands in Stage N');
  }

  selectorUsage(_token: string): SelectorUsage {
    // Conservative default: no selector graph yet, so treat every class as fully load-bearing.
    return OPAQUE_USAGE;
  }
}

/** Factory: build a Tailwind-backed {@link StyleResolver}. */
export function createTailwindResolver(config?: TailwindResolverConfig): StyleResolver {
  return new TailwindResolver(config);
}
