# domflax · Next.js + Tailwind example

A small, runnable Next.js (App Router) + Tailwind CSS app that wires up **domflax** through its
**webpack adapter** so that markup is optimized at build time.

This example is **standalone** — it is not a workspace member. It depends on the local domflax
package via `"domflax": "file:../../packages/domflax"`.

## What domflax does here (0.1.1)

domflax is a compile-time DOM flattener and semantic CSS compressor: it rewrites your `.jsx`/`.tsx`
to the smallest equivalent DOM, matching on **computed styles** (not raw class names), so the
rendered UI is identical while the DOM has fewer nodes and shorter class sets. It is **conservative
and static-only** — it only makes a change it can prove is render-identical.

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

1. **Flatten — inert wrappers** (`FlattenDemo.tsx`) — wrappers that establish no layout context and
   paint nothing collapse into their child: two nested empty `<div>`s and a single-child
   `display:contents` wrapper are dropped → **fewer DOM nodes**. A flex-centering wrapper is
   **conservatively preserved** (see below); its child is only compressed `h-10 w-10` → `size-10`.
2. **Compress — verbose class sets** (`CompressDemo.tsx`) — equivalent class sets collapse to their
   shortest Tailwind form: `px-4 py-4` → `p-4`, `w-8 h-8` → `size-8`, `top-0 right-0 bottom-0 left-0`
   → `inset-0`, and `h-10 w-10` → `size-10` **even on an element with a dynamic `{count}` child**.
3. **List — mapped rows** (`ListDemo.tsx`) — JSX inside `.map(...)` **is optimized in 0.1.1**: each
   row's inert wrapper `<div>` is flattened and `px-4 py-4` → `p-4`, while the dynamic `{item.*}`
   values and **stable `key`s are preserved**.
4. **Async** (`AsyncDemo.tsx`) — an `async` Server Component that awaits fake fetched data. domflax
   leaves **dynamic / async content untouched** — the data renders exactly as fetched.

The rendered UI is identical with and without domflax; the difference is in the emitted DOM (fewer
nodes, shorter class lists).

### What domflax does *not* do: flex/grid centering wrappers are preserved

domflax does **not** flatten flex/grid **centering** wrappers. A flex/grid wrapper establishes its
child's layout context, so removing it cannot be statically proven render-identical — domflax
**conservatively preserves it**. The centering wrapper in `FlattenDemo.tsx` (and the header wrapper
in `app/page.tsx`) is therefore **kept**, and **no `place-self-center` is emitted**. Context-aware
or opt-in-verified flattening of those wrappers is a [Roadmap](../../README.md#roadmap) item.

You can see the transform on a single component directly:

```bash
node -e "const {createDomflax}=require('domflax');const fs=require('fs');const c=fs.readFileSync('components/FlattenDemo.tsx','utf8');console.log(createDomflax({provider:'tailwind'}).transform(c,require('path').resolve('components/FlattenDemo.tsx')).code)"
```

For `FlattenDemo.tsx` the two nested no-op `<div>`s and the single-child `display:contents` wrapper
are removed, while the flex-centering wrapper survives with its child compressed to
`<div className="rounded bg-indigo-200 size-10" />`.

### In the build output

After `npm run build`, the optimized classes appear directly in the emitted chunks:

```bash
grep -rho 'size-10\|size-8\|inset-0\|p-4' .next/server .next/static | sort | uniq -c   # compressed forms
```

Observed output:

```
      5 inset-0
     33 p-4
      9 size-10
      5 size-8
```

The verbose **class-attribute** form `top-0 right-0 bottom-0 left-0` is gone:

```bash
grep -rho 'top-0 right-0 bottom-0 left-0' .next/server .next/static   # → nothing
```

> Note: the literal strings `px-4 py-4`, `w-8 h-8`, and `h-10 w-10` still appear in the output, but
> only because the demo components print them as human-readable `<code>` labels — those are display
> text, not `className` attributes. The actual class attributes carrying those styles were compressed
> to `p-4`, `size-8`, and `size-10`.

## Files

- `next.config.js` — wires the domflax webpack adapter.
- `tailwind.config.js`, `postcss.config.js`, `app/globals.css` — Tailwind v3 setup.
- `app/layout.tsx`, `app/page.tsx` — App Router shell + async Server Component page.
- `components/*.tsx` — the four demos described above.
