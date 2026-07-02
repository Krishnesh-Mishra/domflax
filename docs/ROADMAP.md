# domflax Roadmap → 1.0

The pattern library grows with engine capability, not ahead of it: every pattern must **fire on real
code** and be **provably (or verifiably) render-neutral**. Pure-static flattening supports roughly
15–20 genuinely distinct patterns, so each release below adds the engine capability that unlocks its
next pattern batch — deeper static CSS reasoning, an opt-in render-verified tier, and new frontends
(each frontend is a whole new pattern domain). Counts are cumulative minimums.

## 0.2.0 — current

- General **compress engine** (minimal-string exact-cover; Tailwind v3 + v4 + custom CSS; re-resolve
  backstop — never changes rendering, never worse than the original).
- Tailwind **v4** support + fail-safe (unresolvable classes are never flattened).
- Lean, validated flatten library (**8 patterns**), HTML frontend (parse5, surgical), grid-parent
  centering flatten, memory-bounded parallel CLI, per-page `<link>` CSS auto-detection, build-end
  summary, `--details`.

## 0.3.0 — Reach: see more of real codebases (~25 patterns)

The biggest limiter in real React apps is what domflax is *allowed to look at*.

- **`cn()` / `clsx()` / template-literal static extraction** — compress the static string arguments
  of `cn("px-4 py-4", cond && "…")` and the static head of template classNames, leaving dynamic parts
  untouched. (~24% of classNames in a typical shadcn app are currently opaque.)
- **Arbitrary-value synthesis** in the compress engine (`h-[40px] w-[40px]` → `size-[40px]`;
  variant-aware compression for `hover:` / `md:` / `dark:` groups).
- **Deeper static layout reasoning** in the flatten gate: margin-collapse modeling, grid/flex item
  sizing — turning more wrapper removals provable *without* a browser.
- Pattern batch: sibling-merge, list/table wrappers, form-control wrappers made provable by the new
  reasoning.

## 0.4.0 — Verified tier: unlock the volume (~60 patterns)

- **Opt-in render-verified flattening for static HTML** (`--verified`): render the *real* page
  before/after in headless Chromium at build time and commit an aggressive flatten only if
  pixel/box/style-identical. Static sites have no auth/data-fetching, so verification is exact.
  Default stays static-only — no browser unless asked.
- Unlocks the context-dependent families static analysis can never prove: **animation-only wrapper
  class-transfer** (`.fade-up` wrappers), multi-child unwraps, flex/grid merges, centering under
  non-grid parents, spacer/divider collapsing.
- Verified-tier patterns are authored with the same `definePattern`, marked `verify: true`.

## 0.5.0 — More frontends, more domains (~100 patterns)

- **Astro static frontend** (`.astro` component markup — statically knowable parents, ideal for
  flattening) and **Vue SFC** `<template>` frontend; groundwork for Svelte.
- **Turbopack support** when it exposes a stable transform API.
- Framework pattern domains: Astro islands/slots, Vue wrapper idioms, Next/RSC fragment patterns.
- **Bootstrap + utility-framework providers** for the compress engine (same exact-cover algorithm,
  new vocabularies) → provider-specific compression without new code.

## 0.6.0 — Performance, DX, ecosystem (~140 patterns)

- **Incremental + watch mode**: content-hash caching so rebuilds only re-optimize changed files;
  persistent cache across builds.
- **`domflax/runtime`** — tiny browser `optimizeHtml(string)` for dynamic HTML before `innerHTML`.
- **`templatize`** (plain-HTML `cloneNode` fast path for repeated structures).
- **Community patterns**: a documented `definePattern` publishing story (npm `domflax-pattern-*`
  packages, auto-discovered), pattern-quality CI (must fire + must verify), and a patterns gallery.
- Benchmarks + docs site.

## 1.0.0 — Stable (200+ patterns)

- **≥ 200 patterns**, every one validated (fires on real code) and safe (statically provable or
  render-verified), across all domains: wrapper / flex / grid / animation / list / table / form /
  fragment / framework-specific (React, Next, Astro, Vue) / provider-specific.
- Frozen public API (`domflax`, `domflax/pattern-kit`, `domflax/verify`, `domflax/runtime`),
  semver guarantees, LTS posture.
- Full docs site, migration guides, published benchmark suite (nodes/bytes saved on real OSS apps).

### How 200 patterns stays honest

A pattern only counts if it (a) uniquely fires on real-world markup (not shadowed by a more general
pattern) and (b) is proven render-neutral — statically, or by the verified tier. The growth comes
from new *capability surface* (extraction, verified tier, new frontends, new providers), not from
splitting existing patterns into variants. Every release's batch is validated against real projects
before it ships, and no-op patterns are dropped.
