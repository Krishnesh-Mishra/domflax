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
 * `emit(styleMap)` is best-effort reverse synthesis backed by a reverse index built from the engine's
 * own class list (`context.getClassList()`): each indexable utility is generated, its normalized BASE
 * declarations are recorded, and the index is greedily matched against the requested StyleMap
 * (largest declaration-sets first), consuming matched properties so each is mapped to at most one
 * utility. The index is built lazily on first `emit()` and cached.
 *
 * LIMITATION (v0.1.0): `emit` is intentionally less complete than `resolve`. It only matches against
 * the engine's enumerable named utilities and only their unconditional BASE declarations; variant
 * conditions (hover/responsive/pseudo-element) and arbitrary-value utilities are not reverse-synthesized,
 * and no synthetic class is produced for the residual (it is surfaced via `exact:false`). Anything
 * with no matching utility is simply left unmatched — `emit` never throws and never invents a class.
 */

export type { TailwindResolverConfig } from './tailwind/config';
export { createTailwindResolver } from './tailwind/resolver';
