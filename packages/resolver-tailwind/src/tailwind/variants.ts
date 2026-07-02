/**
 * @domflax/resolver-tailwind — variant-chain utilities.
 *
 * A Tailwind candidate is `variant:variant:…:utility`. VARIANT-AWARE compression needs to (a) split
 * a token into its variant CHAIN and its ROOT utility, and (b) map a normalized style condition
 * (`ConditionKey`) back to a re-emittable chain. The split is purely lexical here; the resolver
 * VALIDATES every learned mapping by round-tripping through the real engine (the root must resolve
 * BASE-only and the full token must resolve to exactly the root's declarations re-keyed under one
 * single condition) before it is ever used to synthesize prefixed candidates.
 */

/** Result of splitting `md:hover:p-4` → `{ chain: 'md:hover:', root: 'p-4' }`. */
export interface VariantSplit {
  readonly chain: string;
  readonly root: string;
}

/**
 * Split a candidate at its LAST top-level `:` (bracket/paren aware, so arbitrary values/variants
 * like `data-[state=open]:p-4` or `bg-[url(http://x)]` split correctly and `[color:red]` — a bare
 * arbitrary property with no variant — returns `null`). Returns `null` when the token carries no
 * variant chain.
 */
export function splitVariantChain(token: string): VariantSplit | null {
  let depth = 0;
  let last = -1;
  for (let i = 0; i < token.length; i += 1) {
    const c = token[i]!;
    if (c === '[' || c === '(') depth += 1;
    else if (c === ']' || c === ')') depth = Math.max(0, depth - 1);
    else if (c === ':' && depth === 0) last = i;
  }
  if (last <= 0 || last === token.length - 1) return null;
  return { chain: token.slice(0, last + 1), root: token.slice(last + 1) };
}
