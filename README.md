# domflax

> Compile-time DOM flattener and semantic CSS compressor — fewer DOM nodes, smaller class sets, **identical rendered UI**.

`domflax` analyzes your JSX at build time and rewrites it to a smaller equivalent:

1. **Compress** — collapses verbose class sets into their shortest equivalents (`px-4 py-4 mt-2 mb-2` → `p-4 my-2`, `h-10 w-10` → `size-10`).
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
- **Flattening is conservative.** A wrapper is removed only when removal is *provably* render-neutral — it establishes no layout context and has no style to reproduce on its child. It never drops a style it can't reproduce, and never touches a wrapper a CSS selector depends on (`.list > .item h3`).
- domflax runs as a **purely static** source transform. It never launches a browser, so builds stay fast and deterministic.

> **Status: v0.1.2.** Works end-to-end on real `.jsx`/`.tsx` — in component-return position **and inside `.map()` / expressions (list rows)** — via Vite, Next.js (webpack), and the CLI, with Tailwind and custom-CSS providers. 22 patterns. Wrappers that establish a layout context (e.g. `flex`/`grid` centering) are **conservatively preserved** — proving those render-identical needs context a static pass can't see; recovering them safely is on the Roadmap. APIs may change before 1.0.

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

### Tailwind (auto-detected)

When `tailwindcss` is present, `provider: 'auto'` resolves classes through the real Tailwind engine and emits the shortest equivalent Tailwind classes back. `tailwindcss` is an optional peer, loaded from your project only when used.

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
| `--css <files...>` | Stylesheets when `--provider custom`. |
| `--dry-run` | Preview changes, write nothing. |
| `--dangerously-overwrite-source` | Allow in-place source rewrite (needs clean git). |

## Writing a pattern

Patterns are how domflax knows what's safe to rewrite. Each is a **single declarative file** — the definition and its tests live in one `definePattern` call, with no separate test file and no manual registration:

```ts
import { definePattern } from 'domflax/pattern-kit'

export default definePattern({
  name: 'padding-shorthand',
  category: 'compress/padding-shorthand',
  safety: 1,
  doc: { summary: 'Equal/paired padding longhands collapse to the shortest shorthand.' },
  // a compress recipe rewrites only the element's own class list (declines with null otherwise)
  rewrite: { rewriteClasses: (computed) => foldPadding(computed) },
  test: {
    cases:   [{ before: '<div className="px-4 py-4">{x}</div>', after: '<div className="p-4">{x}</div>' }],
    noMatch: ['<div className="pt-2 pr-4 pb-8 pl-4">box</div>'],
  },
})
```

Drop the file under `src/library/**` as `*.pattern.ts` and it's **auto-discovered**. The generic harness runs every pattern's `test` cases through the *real* transform, plus an automatic invariant suite (purity, opacity-barrier safety, id-preservation, fixpoint termination) — so a new pattern is wired, tested, and proven sound with zero boilerplate. Flatten patterns auto-receive the opacity + selector-safety guards; compress patterns are gated only on dynamic / selector-bound classes.

## Advanced entry points

```ts
import { definePattern } from 'domflax/pattern-kit'  // author custom patterns
import { verifyEquivalence } from 'domflax/verify'   // optional, standalone equivalence checker
```

The transform itself is static and never launches a browser. `domflax/verify` is a **separate, opt-in tool** that renders before/after in headless Chromium (via Playwright, an optional peer) and diffs pixels + box geometry + computed styles — handy for vetting patterns, *not* part of your build.

## Examples

Runnable examples live in [`examples/`](./examples): `vite-react-tailwind`, `vite-custom-css` (custom provider + selector-safety), and `next-tailwind`.

## Roadmap

- [x] Monorepo + single bundled package
- [x] Core engine (IR, pass manager, surgical full-module codegen)
- [x] Declarative `definePattern({ …, test })` + auto-discovery; 22 flatten/compress patterns
- [x] Real Tailwind engine + custom-CSS resolvers
- [x] CSS selector-safety + residual-skip (don't break `div div h1`; never drop un-reproducible styles)
- [x] Compression across dynamic content (refs / handlers / `{expr}` children)
- [x] Optimize JSX inside `.map()` / expressions (list rows)
- [x] Vite + Next.js (webpack) adapters + CLI (folders, wizard, output-safety)
- [x] Standalone equivalence verifier (Playwright, opt-in)
- [ ] Context-aware (or opt-in-verified) flatten for `flex`/`grid` centering wrappers
- [ ] HTML frontend (plain `.html` / Astro static)
- [ ] `domflax/runtime` — optimize dynamic HTML strings before `innerHTML`
- [ ] More providers; `templatize` (plain-HTML cloneNode)

## License

See [LICENSE](./LICENSE) (Domflax Software License 1.0). The `domflax/runtime`, `domflax/cli`, and pattern-library components are additionally available under the MIT License per the Runtime Exception.

© Krishnesh Mishra
