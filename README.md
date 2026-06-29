# domflax

> Compile-time DOM flattener and semantic CSS compressor — fewer DOM nodes, smaller class sets, **identical rendered UI**.

`domflax` analyzes your markup at build time and rewrites it to the smallest equivalent DOM:

1. **Flatten** — removes redundant wrapper elements (fewer DOM nodes).
2. **Compress** — collapses verbose class/style sets into minimal equivalents.

The key idea: matching happens on **computed styles**, not raw class names. So instead of hard-coding `flex justify-center items-center`, domflax understands *"this is a centering wrapper"* — so the same rules work across Tailwind, custom CSS, and (later) other providers.

```html
<!-- before: 2 nodes -->
<div class="w-full h-full flex justify-center items-center">
  <div class="h-10 w-10 bg-red-200">Hello</div>
</div>

<!-- after: 1 node, same UI -->
<div class="h-10 w-10 bg-red-200 place-self-center">Hello</div>
```

It only ever rewrites the **static shape** of your markup. Dynamic content (`{expr}`, components, `.map()` data, `dangerouslySetInnerHTML`) is treated as opaque and preserved — so `async`/data-fetching code is unaffected. Every transform is backed by an equivalence verifier that renders before/after and proves the UI is identical.

> **Status: v0 (early scaffold).** The architecture, core engine, pattern kit, and the first flatten pattern are implemented and tested; the JSX/HTML frontends and resolvers are still being built out, so the bundler adapters currently pass source through unchanged. APIs may change before 1.0.

## Install

```bash
npm install -D domflax
```

One install, one package. Everything is a subpath of `domflax` — there are no separate packages to add.

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
    config.plugins.push(domflax.webpack({ provider: 'auto' }))
    return config
  },
}
```

> domflax runs as a **source transform** on your `.jsx`/`.tsx` (and `.html`) files via the bundler — it never touches a framework's shipped `index.html`. Turbopack support is pending (it doesn't accept arbitrary webpack loaders yet).

### Tailwind (auto-detected)

When `tailwindcss` is a dependency, `provider: 'auto'` resolves classes through Tailwind's own engine and emits the shortest equivalent Tailwind classes back.

### Custom CSS files

No Tailwind? Point domflax at your stylesheets; it builds forward (class → style) and reverse (style → class) maps from them.

```ts
domflax.vite({ provider: 'custom', cssFiles: ['./src/styles/main.css'] })
```

## CLI

domflax also runs standalone — point it at a folder (provider and file types auto-detected) or at files, including plain `.html`. Run it with no arguments for an interactive wizard.

```bash
npx domflax                 # interactive wizard (arrow keys, multiselect)
npx domflax ./src --dry-run # preview diffs, write nothing
npx domflax ./src --out ./domflax-out
```

**Source is never overwritten by default.** Output goes to `--out` (or `./domflax-out`), or in place only inside disposable build dirs (`dist/`, `build/`). Rewriting source in place requires the explicit `--dangerously-overwrite-source` flag *and* a clean git tree.

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
import { verifyEquivalence } from 'domflax/verify'                   // standalone CI equivalence check
```

`domflax/verify` uses Playwright (an optional peer — installed only if you use it).

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `provider` | `'auto' \| 'tailwind' \| 'custom'` | `'auto'` | How class names resolve to computed styles. |
| `cssFiles` | `string[]` | `[]` | Stylesheets when `provider` is `'custom'`. |
| `safety` | `0–3` | `2` | Aggressiveness (0 lint … 3 aggressive). |
| `dryRun` | `boolean` | `false` | Preview without rewriting. |

## Roadmap

- [x] Architecture + monorepo + single-package publish wiring
- [x] Core engine: IR, pass manager, op applier
- [x] Pattern kit (combinator DSL) + first pattern (`flatten/flex-center-wrapper`)
- [ ] Stage 1: Babel JSX frontend + Tailwind resolver + surgical codegen (real end-to-end)
- [ ] CSS selector-safety analysis (don't break `div div h1`, `:nth-child`)
- [ ] More flatten/compress patterns
- [ ] HTML frontend + CLI (folders, plain HTML)
- [ ] Equivalence verifier (Playwright)
- [ ] `domflax/runtime` — optimize dynamic HTML strings before `innerHTML`
- [ ] Bootstrap & other providers; templatize (plain HTML)

## License

See [LICENSE](./LICENSE) (Domflax Software License 1.0). The `domflax/runtime`, `domflax/cli`, and pattern-library components are additionally available under the MIT License per the Runtime Exception.

© Krishnesh Mishra
