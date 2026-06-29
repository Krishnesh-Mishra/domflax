# domflax

> Compile-time DOM flattener and semantic CSS compressor — fewer DOM nodes, smaller class sets, **identical rendered UI**.

`domflax` analyzes your markup at build time and rewrites it to the smallest equivalent DOM:

1. **Flatten** — removes redundant wrapper elements (reduces node count).
2. **Compress** — collapses verbose class/style sets into minimal equivalents.

The key idea: matching happens on **computed styles**, not raw class names. So instead of hard-coding `flex justify-center items-center`, domflax understands *"this is a centering wrapper"* — which means the same rules work across Tailwind, custom CSS, and (later) other providers.

```html
<!-- before: 2 nodes -->
<div class="w-full h-full flex justify-center items-center">
  <div class="h-10 w-10 bg-red-200">Hello</div>
</div>

<!-- after: 1 node, same UI -->
<div class="h-10 w-10 bg-red-200 place-self-center">Hello</div>
```

> **Status: v0 (early scaffold).** The API below is the target design. The transform currently returns input unchanged while the architecture is built out.

## Install

```bash
npm install -D domflax
```

## How it will work

domflax ships one core transform with thin adapters per environment, so a pattern written once works everywhere.

### Vite

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import domflax from 'domflax/vite'

export default defineConfig({
  plugins: [domflax({ provider: 'auto' })],
})
```

### Next.js

```js
// next.config.js
const domflax = require('domflax/webpack')

module.exports = {
  webpack(config) {
    config.plugins.push(domflax({ provider: 'auto' }))
    return config
  },
}
```

### Tailwind (auto-detected)

When `tailwindcss` is a dependency, `provider: 'auto'` resolves classes through Tailwind's own engine and emits the shortest equivalent Tailwind classes back.

```ts
domflax({ provider: 'tailwind' })
```

### Custom CSS files

No Tailwind? Point domflax at your stylesheets. It builds forward (class → style) and reverse (style → class) maps from them.

```ts
domflax({
  provider: 'custom',
  cssFiles: ['./src/styles/main.css', './node_modules/some-lib/dist/styles.css'],
})
```

### CLI (plain HTML, folders, CI)

domflax also runs standalone — no bundler required. Point it at a folder (it auto-detects the provider and file types) or at individual files, including plain `.html`.

```bash
# whole folder — auto-detects Tailwind/custom CSS and file types
npx domflax ./src

# specific globs
npx domflax "src/**/*.{jsx,tsx,html}"

# plain HTML files work too
npx domflax ./public/index.html

# preview without writing anything
npx domflax ./src --dry-run

# force a provider / point at custom stylesheets
npx domflax ./src --provider custom --css ./styles/main.css
```

| Flag                | Description                                                        |
| ------------------- | ------------------------------------------------------------------ |
| `<path>`            | Folder (auto-scanned) or glob of files to process.                 |
| `--provider <name>` | `auto` (default), `tailwind`, or `custom`.                         |
| `--css <files...>`  | Stylesheets to parse when `--provider custom`.                     |
| `--dry-run`         | Print proposed changes without rewriting files.                    |
| `--report`          | Print a summary (nodes removed, classes saved, bytes saved).       |

Supported inputs: `.jsx`, `.tsx`, and plain `.html`. JSX/TSX go through an AST transform; HTML goes through an HTML parser — both share the same core flatten + compress logic.

## Options

| Option     | Type                              | Default  | Description                                          |
| ---------- | --------------------------------- | -------- | ---------------------------------------------------- |
| `provider` | `'auto' \| 'tailwind' \| 'custom'`| `'auto'` | How class names resolve to computed styles.          |
| `cssFiles` | `string[]`                        | `[]`     | Stylesheets to parse when `provider` is `'custom'`.  |
| `dryRun`   | `boolean`                         | `false`  | Preview changes without rewriting source.            |

## Roadmap

- [x] Project scaffold + core API surface
- [ ] Core transform pipeline (parse → resolve → flatten → compress → emit)
- [ ] Tailwind resolver
- [ ] Custom CSS resolver
- [ ] Vite / Next.js adapters
- [ ] CLI for plain HTML
- [ ] Bootstrap & other providers

## License

MIT © Krishnesh Mishra
