# domflax Roadmap → 1.0

Strategy: **ship every engine capability early (0.3.0)**, so later releases can focus on one thing
each — patterns ride on capabilities, so building all capabilities first makes the pattern-only and
performance-only releases clean. A pattern only ever counts if it **uniquely fires on real code** and
is **proven render-neutral** (statically, or by the verified tier) — the count grows from capability
surface, never from padding.

## 0.2.0 — current (published)

General compress engine (minimal-string exact-cover; Tailwind v3 + v4 + custom CSS; re-resolve
backstop), Tailwind v4 support + fail-safe, lean validated flatten library (8 patterns), HTML
frontend (parse5, surgical), grid-parent centering flatten, memory-bounded parallel CLI, per-page
`<link>` CSS auto-detection, build-end summary, `--details`.

## 0.3.0 — The capability release (~18 patterns)

Everything the future pattern batches will stand on, in one release:

- **`cn()` / `clsx()` / template-literal static extraction** — compress the static string parts of
  `cn("px-4 py-4", cond && "…")` and template classNames, leaving dynamic parts untouched (unlocks
  the ~25% of classNames that are opaque in a typical shadcn app).
- **Arbitrary-value + variant-aware compression** — `h-[40px] w-[40px]` → `size-[40px]`; compress
  inside `hover:` / `md:` / `dark:` groups.
- **Deeper static layout reasoning** — margin-collapse and grid/flex item-sizing modeling in the
  flatten gate, so more wrapper removals are provable without a browser.
- **Verified tier (opt-in `--verified`)** — for static HTML: render the real page before/after in
  headless Chromium at build time; commit an aggressive flatten only if pixel/box/style-identical.
  Unlocks animation-wrapper class-transfer (`.fade-up`), multi-child unwraps, flex/grid merges,
  non-grid centering. Default stays static-only (no browser unless asked).
- **New frontends** — Astro static (`.astro`) and Vue SFC `<template>`; Turbopack when it exposes a
  stable transform API.
- **More providers** — Bootstrap (and friends) plugged into the compress engine as new vocabularies.
- **Audit / score mode** — `npx domflax --audit` changes nothing and reports how much smaller the DOM
  could be (totals + worst files). A Lighthouse-style score for DOM bloat.
- **Config file + typed inline config** — `domflax.config.js` for the CLI, and the same options
  passed directly where the plugin is called (`domflax.vite({ …config })`); a `DomflaxConfig` type is
  exposed so configs are type-checked and reusable.
- **Inline-style converter** — swap `style="padding:16px"` for an equivalent existing class (or the
  reverse) whenever that's shorter and provably identical.
- **`domflax/runtime`** — tiny browser `optimizeHtml(string)` for dynamic HTML before `innerHTML`.
- **`templatize`** — plain-HTML `cloneNode` fast path for repeated structures.
- **+10 validated patterns** riding the new capabilities (first verified-tier and extraction-enabled
  ones included).

## 0.4.0 — The pattern release (~118 patterns)

Nothing but patterns: **+100 validated patterns**, built on 0.3.0's capabilities, mined from two
corpora:

- **~50 from real sites & frontends** — wrapper / flex / grid / animation (class-transfer) / list /
  table / form / fragment / framework-specific (React, Next, Astro, Vue) shapes profiled from real
  projects.
- **~50 from component-library corpora** — shadcn, HeroUI, Tailwind UI, DaisyUI, MUI-rendered-HTML,
  etc. Patterns match **structure + computed style, never library identity**, so a shape mined from
  shadcn fires for anyone hand-writing similar markup. Copy-in libraries (shadcn-style, code in your
  repo) are optimized directly at source; runtime libraries' shapes pay off in hand-written lookalikes
  and static-HTML exports — and these same patterns become the ready-made library knowledge that
  0.6.0's **compiled-component optimization** applies inside the bundle (patterns ship in 0.4, the
  node_modules optimizer that uses them ships in 0.6).

Each batch is validated against real projects before it ships; shadowed/no-op patterns are dropped.

## 0.5.0 — The performance release

- **Incremental + watch mode** — content-hash caching so rebuilds only re-optimize changed files;
  persistent cache across builds; dev-server friendly.
- **CSS-side shrinking** — after class compression, rules no longer used by anything are removed from
  the stylesheet too, so the CSS file shrinks alongside the DOM.
- Faster resolver startup (v4 bridge warm cache), lower memory per worker, smarter pool scheduling.
- Published **benchmark suite** (speed + savings on real OSS apps).
- Pattern count keeps growing in the background (community + small batches).

## 0.6.0 — Feature release

- **HTML report page** — after a run, generate one shareable `report.html` with before/after diffs
  per file, totals, and charts.
- **Compiled-component optimization (opt-in `optimizeDeps`)** — a **compiled-JSX frontend** that
  parses the `jsx()` / `jsxs()` / `createElement()` calls published libraries ship, so domflax can
  optimize runtime component libraries (HeroUI, DaisyUI/Flowbite-style) *inside the bundle* at build
  time — no copy-in needed, and hydration-safe because server and client render from the same
  optimized code. Strongest for Tailwind-based libraries (static class strings, plus `tv()`/`cva()`
  extraction); CSS-in-JS libraries (MUI/emotion) generate class names at runtime and stay
  structure-only. Backed by per-library **presets**: pre-verified knowledge of which wrappers of a
  given library version are safe.
- Plus the next round of owner's picks. Remaining candidates: editor integration (VS Code hints +
  quick-fix), ESLint plugin, dead-attribute cleanup, PR reports. Patterns continue to accumulate.

## 1.0.0 — Stable (200+ patterns)

- **≥ 200 patterns**, every one validated and safe, across all domains and providers.
- Frozen public API (`domflax`, `domflax/pattern-kit`, `domflax/verify`, `domflax/runtime`), semver
  guarantees, LTS posture.
- Full docs site, migration guides, published benchmarks.
