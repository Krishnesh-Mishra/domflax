/**
 * @domflax/resolver-tailwind — Tailwind-aware {@link StyleResolver}, backed by the REAL Tailwind
 * engine.
 *
 * ## Engine + approach
 *
 * The {@link StyleResolver} contract is **synchronous**. For a **v3** project the resolver drives the
 * engine directly (`createContext(resolveConfig(...))` + `generateRules(candidates, ctx)`) — the same
 * synchronous JIT path `prettier-plugin-tailwindcss` and the Tailwind IntelliSense engine use.
 *
 * For a **v4** project (whose entire programmatic surface — `compile`, `__unstable__loadDesignSystem`
 * — is async, with no synchronous design-system constructor) the resolver builds an equivalent
 * synchronous engine from a one-time SNAPSHOT: at construction it loads the project's REAL design
 * system in a short-lived child process (`@tailwindcss/node`'s `__unstable__loadDesignSystem`),
 * enumerates its full class list, and captures each utility's CSS via `candidatesToCss`. That snapshot
 * is parsed (v4's nested authoring CSS is flattened to the same node shape v3 emits — see
 * `v4-css.ts`) into an object that satisfies the SAME internal engine interface, so everything below
 * (extract / emit / serialize) is version-agnostic. SAFETY: if the v4 snapshot cannot be built
 * (missing `@tailwindcss/node`, load error, timeout), the resolver falls back to reporting every class
 * `unknown`, so files are left unchanged — never a wrong resolution. v4 arbitrary-value/variant tokens
 * that are not in the enumerated class list are likewise reported `unknown` (⇒ preserved).
 *
 * ## Forward (`resolve`)
 *
 * `resolve(classes)` feeds each candidate class name to the real engine, reads back the generated
 * CSS rules, and converts them into a normalized, condition-keyed {@link StyleMap}:
 *
 *   • a simple `.utility { … }` rule contributes to the unconditional `BASE_CONDITION` block,
 *   • a `:hover` / `:focus` / … suffix becomes a `StyleCondition.states` entry,
 *   • a `::before` / `::placeholder` / … suffix becomes a `StyleCondition.pseudoElement`,
 *   • a wrapping `@media (…)` (responsive variants like `md:`) becomes `StyleCondition.media`.
 *
 * Every declaration is run through the SHARED {@link normalizer} from `@domflax/pattern-kit`, so
 * values are canonical and box shorthands (`p-4`, `gap-4`, `inset-0`, …) expand to longhands exactly
 * the way patterns + verify expect. BASE coverage is the must-have; variant conditions are produced
 * best-effort. Utilities whose selector uses a combinator / compound / attribute selector (e.g.
 * `space-x-4`, `divide-y`) cannot be folded onto the element's own box and are surfaced as
 * {@link OpaqueToken}s rather than contributing misleading declarations. Unknown / unresolvable
 * classes contribute nothing and are reported in `unknown` — `resolve` never throws.
 *
 * ## Reverse (`emit`)
 *
 * `emit(styleMap)`'s primary path is the provider-uniform minimal-string EXACT COVER (see
 * `tailwind/cover.ts`), searched per condition block over three candidate layers:
 *
 *   • ENUMERATED — every base-condition utility from the engine's class list;
 *   • SYNTHESIZED — arbitrary-value `stem-[value]` candidates for one-property families
 *     (padding/margin sides, w/h/`size`, gap, inset sides, `rounded`, top/right/bottom/left —
 *     see `tailwind/synthesize.ts`), each ROUND-TRIP VALIDATED through the real engine before
 *     admission (so `h-[40px] w-[40px]` folds to `size-[40px]`);
 *   • VARIANT-PREFIXED — for a non-base block whose variant chain was learned (round-trip
 *     validated) from a real token, enumerated + synthesized candidates re-prefixed with that
 *     exact chain (so `hover:px-4 hover:py-4` folds to `hover:p-4`). Different chains never mix.
 *
 * The chosen set is verified by the mandatory re-resolve backstop (tuple-exact) before being
 * returned. When no exact cover exists the greedy BASE-only reverse index is the fallback; anything
 * it cannot match is surfaced via `exact:false` — `emit` never throws and never invents a class.
 */

export type { TailwindResolverConfig } from './tailwind/config';
export { createTailwindResolver } from './tailwind/resolver';
