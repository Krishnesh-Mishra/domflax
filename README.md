# domflax

> Compile-time DOM flattener and semantic CSS compressor — fewer DOM nodes, smaller class sets, **identical rendered UI**.

`domflax` analyzes your markup at build time and rewrites it to a smaller equivalent DOM:

1. **Flatten** — removes redundant wrapper elements (fewer DOM nodes).
2. **Compress** — collapses verbose class sets into minimal equivalents (`px-4 py-4` → `p-4`, `w-10 h-10` → `size-10`).

The key idea: matching happens on **computed styles**, not raw class names. So instead of hard-coding `flex justify-center items-center`, domflax understands *"this is a centering wrapper"* — so the same rules work across Tailwind, custom CSS, and (later) other providers.

```tsx
// before: 2 nodes
<div className="w-full h-full flex justify-center items-center">
  <div className="h-10 w-10 bg-red-200">Hello</div>
</div>

// after: 1 node, same UI
<div className="bg-red-200 size-10 place-self-center">Hello</div>
```

It only ever rewrites the **static shape** of your markup. Dynamic content (`{expr}`, components, `dangerouslySetInnerHTML`) is opaque and preserved — `async`/data-fetching code is unaffected. It refuses to flatten a wrapper a CSS selector depends on (`.list > .item h3`) or whose styles it can't safely reproduce.

> **Status: v0.1.0 — early but real.** Works end-to-end on real `.jsx`/`.tsx` modules via Vite, Next.js (webpack), and the CLI, with Tailwind and custom-CSS providers. **Scope:** it optimizes JSX in **component-return position**. Optimizing inside `.map()`/list rows is the next milestone (see Roadmap) — list rows are currently left unchanged. APIs may change before 1.0.

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

## Advanced entry points

```ts
import { definePattern, and, computed } from 'domflax/pattern-kit'  // author custom patterns
import { verifyEquivalence } from 'domflax/verify'                   // standalone equivalence check
```

`domflax/verify` renders before/after in headless Chromium and diffs pixels + box geometry + computed styles to prove the UI is identical. It uses Playwright (an optional peer — installed only if you use it).

## Examples

Runnable examples live in [`examples/`](./examples): `vite-react-tailwind`, `vite-custom-css` (custom provider + selector-safety), and `next-tailwind`.

## Roadmap

- [x] Monorepo + single bundled package
- [x] Core engine (IR, pass manager, surgical full-module codegen)
- [x] Pattern kit (declarative `pattern()` + auto-discovery) and 10 flatten/compress patterns
- [x] Real Tailwind engine + custom-CSS resolvers
- [x] CSS selector-safety + residual-skip (don't break `div div h1`; never drop un-reproducible styles)
- [x] Vite + Next.js (webpack) adapters + CLI (folders, wizard, output-safety)
- [x] Equivalence verifier (Playwright)
- [ ] **Optimize JSX inside `.map()` / expressions (list rows) — next milestone**
- [ ] HTML frontend (plain `.html` / Astro static)
- [ ] `domflax/runtime` — optimize dynamic HTML strings before `innerHTML`
- [ ] Bootstrap & other providers; `templatize` (plain-HTML cloneNode)

## License

See [LICENSE](./LICENSE) (Domflax Software License 1.0). The `domflax/runtime`, `domflax/cli`, and pattern-library components are additionally available under the MIT License per the Runtime Exception.

© Krishnesh Mishra
