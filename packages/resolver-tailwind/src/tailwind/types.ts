/**
 * @domflax/resolver-tailwind — internal types describing the slice of the Tailwind v3 engine's
 * postcss-node shape we read back. These mirror the (untyped) CommonJS internals; only the fields we
 * actually consume are modelled.
 */

export interface TwGeneratedDecl {
  readonly type: 'decl';
  readonly prop: string;
  readonly value: string;
  readonly important?: boolean;
}
export interface TwGeneratedRule {
  readonly type: 'rule';
  readonly selector: string;
  readonly nodes?: readonly TwNode[];
}
export interface TwGeneratedAtRule {
  readonly type: 'atrule';
  readonly name: string;
  readonly params: string;
  readonly nodes?: readonly TwNode[];
}
export type TwNode =
  | TwGeneratedDecl
  | TwGeneratedRule
  | TwGeneratedAtRule
  | { readonly type: string };

export interface TwContext {
  getClassList(): unknown[];
}

export interface TwEngine {
  readonly version: string;
  readonly context: TwContext;
  /** Generate the postcss rule nodes Tailwind emits for the given candidate class names. */
  generate(candidates: readonly string[]): TwNode[];
  /**
   * OPTIONAL: warm the engine for candidates OUTSIDE the enumerable class list (synthesized
   * arbitrary-value / variant-prefixed tokens). The v3 JIT needs no priming (`generate` compiles any
   * candidate on demand); the v4 snapshot engine batches ALL misses into ONE bridge call here so the
   * subsequent per-token `generate` lookups hit the snapshot. Misses are negative-cached.
   */
  prime?(candidates: readonly string[]): void;
}
