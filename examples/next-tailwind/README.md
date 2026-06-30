# domflax · Next.js + Tailwind example

A small, runnable Next.js (App Router) + Tailwind CSS app that wires up **domflax** through its
**webpack adapter** so that markup is optimized at build time.

This example is **standalone** — it is not a workspace member. It depends on the local domflax
package via `"domflax": "file:../../packages/domflax"`.

## What domflax does here

domflax is a compile-time DOM flattener and semantic CSS compressor: it rewrites your `.jsx`/`.tsx`
to the smallest equivalent DOM, matching on **computed styles** (not raw class names), so the
rendered UI is identical while the DOM has fewer nodes and shorter class sets.

`next.config.js` wires the adapter into Next's webpack config:

```js
const domflax = require('domflax');

module.exports = {
  webpack(config) {
    // Pushes a real webpack plugin; on apply(compiler) it appends a pre-enforced module.rule that
    // runs the domflax loader on every .jsx/.tsx module.
    config.plugins.push(domflax.webpack({ provider: 'tailwind' }));
    return config;
  },
};
```

With `provider: 'tailwind'`, domflax resolves classes through your project's own Tailwind v3 engine
(loaded from this app's `node_modules`) and emits the shortest equivalent Tailwind classes back.

## Prerequisites

domflax must be **built first** (this example consumes its `dist/`). From the **repo root**:

```bash
npm install                 # install the monorepo (once)
npm run build -w domflax     # build packages/domflax → packages/domflax/dist
```

> If another process is already rebuilding domflax, just wait for its `dist/` to exist (re-run the
> build once if you hit a transient error).

## Run

From **this directory** (`examples/next-tailwind/`):

```bash
npm install     # installs next, react, tailwind, and links local domflax
npm run build   # production build — uses webpack, which runs the domflax adapter
npm run dev     # or: dev server (webpack)
```

> **Use `next build` (webpack).** Turbopack (`next dev --turbopack`) is **NOT yet supported** by
> the adapter — Turbopack does not accept arbitrary webpack loaders, so the wiring above is a no-op
> under Turbopack. Stick to the default webpack builder.

Then open http://localhost:3000 (for `npm run dev`).

## What to observe

The page renders four demos (`app/page.tsx` + `components/`):

1. **Flatten** (`FlattenDemo.tsx`) — a flex-centering wrapper and nested no-op `<div>`s around a
   single child. domflax folds the centering onto the child and drops the redundant wrappers →
   **fewer DOM nodes**.
2. **Compress** (`CompressDemo.tsx`) — verbose, equivalent class sets (`px-4 py-4`, `w-8 h-8`,
   `top-0 right-0 bottom-0 left-0`) collapse to their shortest Tailwind form → **shorter class
   sets**, same computed styles.
3. **List** (`ListDemo.tsx`) — a `.map(...)` list where each row has a redundant wrapper. The static
   wrapper shape flattens while the dynamic `{item.*}` values and **stable `key`s are preserved**.
4. **Async** (`AsyncDemo.tsx`) — an `async` Server Component that awaits fake fetched data. domflax
   leaves **dynamic / async content untouched** — the data renders exactly as fetched.

The rendered UI is identical with and without domflax; the difference is in the emitted DOM (fewer
nodes, shorter class lists). Compare the rendered HTML with the adapter enabled vs. commented out in
`next.config.js` to see the reduction.

You can see the transform on a single component directly:

```bash
node -e "const p=require('path');const d=p.dirname(require.resolve('domflax/package.json'));const {createDomflax}=require(p.join(d,'dist/index.js'));const fs=require('fs');const c=fs.readFileSync('components/FlattenDemo.tsx','utf8');console.log(createDomflax({provider:'tailwind'}).transform(c,p.resolve('components/FlattenDemo.tsx')).code)"
```

For `FlattenDemo.tsx` the wrapper-centering `<div>` is removed and its child becomes
`<div className="rounded bg-indigo-200 size-10 place-self-center" />` — `place-self-center` folded
in (flatten) and `h-10 w-10` collapsed to `size-10` (compress).

## Current status / known limitations (domflax v0)

domflax is an early-stage (v0) build. Two rough edges affect this example today:

- **`require('domflax')` under CommonJS throws.** The CJS bundle resolves its webpack loader path
  from `import.meta.url`, which is `undefined` in CommonJS. This example works around it by loading
  domflax's ESM entry from `next.config.js` (see the comment there). The plain documented
  `const domflax = require('domflax')` will start working once the CJS bundle is fixed.
- **The JSX backend currently re-emits only the JSX subtree**, not the full module — it drops the
  surrounding `import`s and `export function …` wrapper. As a result a full `next build` with the
  adapter enabled fails at the *"Collecting page data"* step (e.g. `FlattenDemo is not defined`),
  even though webpack compilation succeeds and the per-component transform (flatten + compress
  above) is correct. Until the backend prints whole modules, run the build with the adapter
  commented out for a green build, and use the per-component command above to observe the
  optimization.

## Files

- `next.config.js` — wires the domflax webpack adapter.
- `tailwind.config.js`, `postcss.config.js`, `app/globals.css` — Tailwind v3 setup.
- `app/layout.tsx`, `app/page.tsx` — App Router shell + async Server Component page.
- `components/*.tsx` — the four demos described above.
