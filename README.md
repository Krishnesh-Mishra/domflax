# domflax

> Compile-time DOM flattener and semantic CSS compressor — fewer DOM nodes, smaller class sets, **identical rendered UI**.

`domflax` analyzes your JSX **and HTML** at build time and rewrites it to a smaller equivalent:

1. **Compress** — a general engine rewrites each element's classes to the **shortest set that produces the same computed style** (`px-4 py-4 mt-2 mb-2` → `p-4 my-2`, `h-10 w-10` → `size-10`). One algorithm across **Tailwind v3, Tailwind v4, and custom CSS** — no per-utility patterns.
2. **Flatten** — removes wrapper elements that are *provably inert* (they add no layout and paint nothing).

Matching happens on **computed styles**, not raw class names — so the rules work across Tailwind, custom CSS, and (later) other providers, and a Tailwind class and an equivalent custom class compress the same way.

```tsx
// before
<div className="contents">
  <div className="px-4 py-4 mt-2 mb-2" onClick={save}>{title}</div>
</div>

// after — the inert wrapper is gone, classes are minimized, behavior is identical
<div className="p-4 my-2" onClick={save}>{title}</div>
```

It rewrites only the **static shape** of your markup. Dynamic class lists (`className={cn(...)}`), components, and `dangerouslySetInnerHTML` are opaque and preserved; `async`/data-fetching code is untouched.

**Safety model — conservative by default, no browser involved.**

- **Compression is always safe.** It only re-serializes an element's *own* class list, so a `ref`, an event handler, a `{dynamic}` child, or `dangerouslySetInnerHTML` never blocks it — only a *dynamic* className (or a class a CSS selector depends on) is left alone.
- **Flattening is conservative.** A wrapper is removed only when removal is *provably* render-neutral — it establishes no layout context and has no style to reproduce on its child. A `flex`/`grid` **centering** wrapper is removed only when its parent is statically `display:grid` (so `place-self:center` is provably equivalent — Chromium-verified); a flex/block/unknown parent leaves it preserved. It never drops a style it can't reproduce, and never touches a wrapper a CSS selector depends on (`.list > .item h3`).
- domflax runs as a **purely static** source transform. It never launches a browser, so builds stay fast and deterministic.

> **Status: v0.2.0.** Optimizes real `.jsx`/`.tsx` **and `.html`** — component-return, inside `.map()`/expressions, and whole static-HTML sites — via Vite, Next.js (webpack), and the CLI. **Compression is one general engine** that emits the shortest class set reproducing each element's computed style, uniformly across **Tailwind v3, Tailwind v4, and custom CSS** (it re-resolves the result and verifies it's identical before emitting). **Flattening** is a lean set of provably-safe structural patterns (inert wrappers + grid-parent centering). **Static-only — never launches a browser** during a build; a Tailwind project it can't resolve is left untouched, never broken. The CLI batches large sites across CPU cores (`--max-memory`, never OOM) and auto-detects each HTML page's own `<link>` stylesheets; the Vite/Next plugins print a build-end optimization summary. APIs may change before 1.0.

## Install

```bash
npm install -D domflax
```

One install, one package. `pattern-kit` and `verify` are subpaths of `domflax` — there are no separate packages to add.

## Usage

### Vite

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import domflax from 'domflax'

export default defineConfig({
  plugins: [domflax.vite({ provider: 'auto' })],
})
```

### Next.js (webpack)

```js
// next.config.js
const domflax = require('domflax')

module.exports = {
  webpack(config) {
    domflax.webpack({ provider: 'tailwind' }).apply(config)
    return config
  },
}
```

> domflax runs as a **source transform** on your `.jsx`/`.tsx` files via the bundler — it never touches a framework's shipped `index.html`. Use `next build` (webpack); **Turbopack is not supported yet** (it doesn't accept arbitrary webpack loaders).

At the end of the build both plugins print a one-box summary of what domflax did:

```
  ▲ domflax
  ────────────────────────────────
   files optimized     42
   DOM nodes removed   318
   classes compressed  1,204
   size saved          18.7 KB
  ────────────────────────────────
```

### Tailwind (auto-detected)

When `tailwindcss` is present, `provider: 'auto'` resolves classes through your project's real Tailwind engine — **Tailwind v3 and v4 are both supported** — and emits the shortest equivalent classes back. `tailwindcss` is an optional peer, loaded from your project only when used. A Tailwind version domflax can't resolve is left untouched (never broken).

### Custom CSS files

No Tailwind? Point domflax at your stylesheets; it parses them (PostCSS) for forward (class → style) and reverse (style → class) resolution, and reads their selectors for safety.

```ts
domflax.vite({ provider: 'custom', cssFiles: ['./src/styles/main.css'] })
```

## CLI

domflax also runs standalone — point it at a folder or files. Run it with no arguments for an interactive wizard.

```bash
npx domflax                 # interactive wizard (arrow keys, multiselect)
npx domflax ./src --dry-run # preview diffs, write nothing
npx domflax ./src --out ./domflax-out
```

**Source is never overwritten by default.** Output goes to `--out` (or `./domflax-out`), or in place only inside disposable build dirs (`dist/`, `build/`). Rewriting source in place requires the explicit `--dangerously-overwrite-source` flag *and* a clean git tree. The wizard never runs in CI / non-TTY.

| Flag | Description |
| --- | --- |
| `<path>` | Folder (auto-scanned) or glob of files. |
| `--out <dir>` | Write optimized output here (mirrors input structure). |
| `--provider <name>` | `auto` (default), `tailwind`, or `custom`. |
| `--css <files...>` | **Global** stylesheets (`--provider custom`); each `.html` page's own `<link>` imports are auto-detected on top. |
| `--max-memory <MB>` | Cap total RAM — and thus worker parallelism. Default ≈ 70% of free RAM; low values run slower but never OOM. |
| `--concurrency <N>` | Cap worker count (memory always wins). |
| `--dry-run` | Preview changes, write nothing. |
| `--details` | Print per-file optimization stats (nodes / classes / bytes). |
| `--dangerously-overwrite-source` | Allow in-place source rewrite (needs clean git). |

### HTML & static sites

domflax optimizes `.html`/`.htm` too (parse5), so you can run it over a **built static site** (`dist/`):

```bash
npx domflax ./dist --provider custom --out ./dist-optimized
```

- **Per-page CSS, automatically.** Each HTML file resolves against the stylesheets *it* links (`<link rel="stylesheet">`, relative + local) plus any global `--css` — so you usually don't select CSS at all, and selector-safety is accurate per page.
- **Centering actually flattens here.** In HTML the parent is statically known, so a `grid`-parent centering wrapper is provably removable (Chromium-verified) — real node removal, not just compression.
- **Big sites, safely parallel.** Large batches run across CPU cores with a memory-bounded worker pool: `--max-memory` caps RAM (and parallelism); a bad or huge file fails just that file (reported), never crashing or OOM-ing the run.
- **Byte-for-byte outside edits** — doctype, comments, whitespace, scripts, and attribute order are preserved; only changed `class` values and unwrapped tags are touched.

## Writing a pattern

Compression is a general engine — there are **no per-utility compress patterns**. Patterns are for **flattening**: each is a single declarative file whose definition and tests live in one `definePattern` call, auto-discovered, with no manual registration:

```ts
import { definePattern, not, hasDynamicClasses } from 'domflax/pattern-kit'

export default definePattern({
  name: 'display-contents-wrapper',
  category: 'flatten/wrapper/display-contents-wrapper',
  safety: 2,
  doc: { summary: 'A display:contents wrapper generates no box — unwrap it into its sole child.' },
  match: {
    tag: 'div',
    style: { display: 'contents' },
    onlyChild: 'element',
    paintsNothing: true,
    where: [not(hasDynamicClasses)],
  },
  rewrite: { flattenInto: 'child' },
  test: {
    cases:   [{ before: '<div className="contents"><a className="text-blue-500">L</a></div>',
                after:  '<a className="text-blue-500">L</a>' }],
    noMatch: ['<div className="contents" ref={r}><a>L</a></div>'],
  },
})
```

Drop the file under `src/library/**` as `*.pattern.ts` and it's **auto-discovered**. The generic harness runs its `test` cases through the *real* transform, plus an automatic invariant suite (purity, opacity-barrier safety, id-preservation, fixpoint termination). Every `flatten/*` pattern auto-receives the opacity + selector-safety guards, and the conservative safety gate only commits a removal it can *prove* is render-neutral — so a pattern can never produce unsafe output.

## Advanced entry points

```ts
import { definePattern } from 'domflax/pattern-kit'  // author custom patterns
import { verifyEquivalence } from 'domflax/verify'   // optional, standalone equivalence checker
```

The transform itself is static and never launches a browser. `domflax/verify` is a **separate, opt-in tool** that renders before/after in headless Chromium (via Playwright, an optional peer) and diffs pixels + box geometry + computed styles — handy for vetting patterns, *not* part of your build.

## Examples

Runnable examples live in [`examples/`](./examples): `vite-react-tailwind`, `vite-custom-css` (custom provider + selector-safety), `next-tailwind`, and `static-html` (CLI optimizing a plain `.html` page with per-page `<link>` CSS auto-detection).

## Roadmap

Done so far: monorepo + single bundled package · core IR/pass engine with surgical codegen · declarative `definePattern` + auto-discovery · the general compress **engine** (Tailwind v3 + v4 + custom CSS) · Tailwind v4 support + fail-safe · selector-safety & residual-skip · compression across dynamic content and inside `.map()` rows · Vite + Next.js adapters with a build-end summary · HTML frontend with per-page `<link>` CSS auto-detection · grid-parent centering flatten (Chromium-verified) · memory-bounded parallel CLI.

Where it's going — each release adds the engine capability that unlocks its next validated pattern batch (full details in [`docs/ROADMAP.md`](./docs/ROADMAP.md)):

| Version | Theme | Patterns |
| --- | --- | --- |
| **0.3.0** | **The capability release** — `cn()`/`clsx()`/template-literal static extraction, arbitrary-value + variant-aware compression, deeper static layout reasoning, the opt-in **verified tier** (render-verified flatten for static HTML), Astro + Vue SFC frontends, Turbopack, more providers | ~18 |
| **0.4.0** | **The pattern release** — +50 validated patterns riding 0.3.0's capabilities (animation class-transfer, list/table/form, framework- and provider-specific) | ~70 |
| **0.5.0** | **The performance release** — incremental/watch caching, faster resolver startup, leaner workers, published benchmarks | ~100 |
| **0.6.0** | **Feature release** — next round of product ideas (audit mode, CSS-side shrinking, editor integration, …) | ~140 |
| **1.0.0** | **Stable** — frozen API, semver guarantees, docs site, published benchmarks | **200+** |

Every pattern that ships must *uniquely fire on real code* and be proven render-neutral (statically or via the verified tier) — the count grows from new capability surface, never from padding.

## License

See [LICENSE](./LICENSE) (Domflax Software License 1.0). The `domflax/runtime`, `domflax/cli`, and pattern-library components are additionally available under the MIT License per the Runtime Exception.

© Krishnesh Mishra
