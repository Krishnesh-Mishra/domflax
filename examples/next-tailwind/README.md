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

The documented `require('domflax')` form works directly under CommonJS — no ESM
workaround needed.

With `provider: 'tailwind'`, domflax resolves classes through your project's own Tailwind v3 engine
(loaded from this app's `node_modules`) and emits the shortest equivalent Tailwind classes back.

## Run

This example consumes domflax's `dist/` via the `file:../../packages/domflax` link
(already built). From **this directory** (`examples/next-tailwind/`):

```bash
npm install     # installs next, react, tailwind, and links local domflax
npm run build   # production build — uses webpack, which runs the domflax adapter
npm run dev     # or: dev server (webpack)
```

A full `next build` with the adapter enabled **completes successfully** — webpack
compiles, all static pages are generated, and the optimized markup is emitted (the
transform round-trips whole modules, so `import`s and `export function …` are
preserved).

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
3. **List** (`ListDemo.tsx`) — a `.map(...)` list where each row has a redundant wrapper. JSX inside
   `.map(...)` callbacks is **not optimized in v0.1.0** (list/expression optimization is a documented
   **Stage-2 roadmap** item), so these per-row wrappers ship as authored; the dynamic `{item.*}`
   values and **stable `key`s are preserved**. domflax v0.1.0 optimizes component-return JSX (demos 1 & 2).
4. **Async** (`AsyncDemo.tsx`) — an `async` Server Component that awaits fake fetched data. domflax
   leaves **dynamic / async content untouched** — the data renders exactly as fetched.

The rendered UI is identical with and without domflax; the difference is in the emitted DOM (fewer
nodes, shorter class lists). Compare the rendered HTML with the adapter enabled vs. commented out in
`next.config.js` to see the reduction.

You can see the transform on a single component directly:

```bash
node -e "const {createDomflax}=require('domflax');const fs=require('fs');const c=fs.readFileSync('components/FlattenDemo.tsx','utf8');console.log(createDomflax({provider:'tailwind'}).transform(c,require('path').resolve('components/FlattenDemo.tsx')).code)"
```

For `FlattenDemo.tsx` the wrapper-centering `<div>` is removed and its child becomes
`<div className="rounded bg-indigo-200 size-10 place-self-center" />` — `place-self-center` folded
in (flatten) and `h-10 w-10` collapsed to `size-10` (compress). The nested three-deep no-op
`<div>`s collapse onto their single child as well.

### In the build output

After `npm run build`, the optimized classes appear directly in the emitted chunks:

```bash
grep -rho 'place-self-center\|size-10\|inset-0\|size-8\|p-4' .next/server .next/static | sort | uniq -c
```

You will see `place-self-center`, `size-10`, `size-8`, `p-4`, and `inset-0` in the output — the
compressed/flattened forms that domflax produced. (Note: the literal strings `px-4 py-4` and
`w-8 h-8` still appear because the demo components print them as human-readable `<code>` labels;
those are display text, not class attributes.)

## Files

- `next.config.js` — wires the domflax webpack adapter.
- `tailwind.config.js`, `postcss.config.js`, `app/globals.css` — Tailwind v3 setup.
- `app/layout.tsx`, `app/page.tsx` — App Router shell + async Server Component page.
- `components/*.tsx` — the four demos described above.
