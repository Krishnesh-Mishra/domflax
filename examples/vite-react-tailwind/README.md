# domflax example — Vite + React + Tailwind

A small, standalone app that runs [domflax](../../packages/domflax) as a Vite build
plugin. It is intentionally written the "verbose" way — flex-centering wrappers,
redundant single-child wrappers, and long class sets like `px-4 py-4` — so you can
watch domflax shrink the DOM and class names at build time without changing the
rendered UI.

This example is **not** a workspace member; it has its own `package.json` and
references domflax via `"domflax": "file:../../packages/domflax"`.

## What the plugin does

domflax analyzes your JSX at build time and rewrites it to the smallest equivalent
shape:

1. **Flatten** — removes redundant wrapper elements (fewer DOM nodes). The
   `<div className="w-full h-full flex justify-center items-center">` wrapper in
   `src/App.tsx` exists only to center its child; domflax pushes `place-self:center`
   onto the child and drops the wrapper. Other empty single-child wrappers in a
   component's returned JSX are removed too.
2. **Compress** — collapses verbose class/style sets into minimal equivalents
   (e.g. `px-4 py-4` → `p-4`, `top-0 right-0 bottom-0 left-0` → `inset-0`).

Matching happens on **computed styles**, not raw class names, and dynamic content
(`{expr}`, components, `.map()` data) is treated as opaque and preserved — so the
list keeps its stable React `key`s and its data.

> **Scope in v0.1.0.** domflax v0.1.0 optimizes JSX in **component-return position**
> (the markup a component returns). JSX written **inside `.map(...)` callbacks** —
> like the feature list in `<Card>` — is **not** optimized yet: list/expression
> optimization is a documented **Stage-2 roadmap** item. The `.map` demo below is
> included as a realistic example, but its per-row wrappers ship as authored.

The transform round-trips the **whole module**: imports, function declarations,
`export default`, and the `render()` call are all preserved — only the JSX shape is
rewritten. The build succeeds **and** the app renders correctly with the plugin
active.

## Run it

domflax's `dist/` is consumed via the `file:../../packages/domflax` link and is
already built. In **this directory** (`examples/vite-react-tailwind/`):

```bash
npm install                 # installs react/vite/tailwind + the file: link to domflax
npm run dev                 # start the dev server
npm run build               # production build into dist/
```

`npm run demo` prints a one-line reminder of how to inspect the result.

## How to see the effect

domflax runs at build time, so the way to observe it is to compare the **authored
source** with **what the plugin emits**. The most direct, dependency-free way is to
call domflax's transform on `src/App.tsx` yourself:

```bash
node --input-type=module -e "
import * as domflax from 'domflax';
import { readFileSync } from 'node:fs';
const eng = domflax.createDomflax({ provider: 'auto' });
console.log(eng.transform(readFileSync('src/App.tsx','utf8'), process.cwd()+'/src/App.tsx').code);
"
```

What you will see (verified against the current engine):

- **Compress — shorter class sets.** In `<Badge>`,
  `absolute top-0 right-0 bottom-0 left-0 w-8 h-8 rounded-full …` becomes
  `absolute rounded-full inset-0 size-8 …`. In `<Card>`, `px-4 py-4` → `p-4`. In
  `<App>`, `w-full h-full` → `size-full`.
- **Flatten — fewer DOM nodes.** The empty single-child `<div>` wrappers collapse
  away (e.g. the bare `<div>` nested inside `<App>`'s centering wrapper is removed).
  Wrappers that actually paint (the `bg-slate-100` centering wrapper, the `.card`)
  are kept — domflax only drops *do-nothing* wrappers. The `.map(...)` feature list
  is left entirely as authored (its per-row wrappers are **not** flattened in
  v0.1.0 — see "Scope in v0.1.0" above); its stable React `key`s and dynamic
  `{expr}` content are preserved.

> When a flattened centering wrapper has no paint of its own, domflax pushes
> `place-self-center` onto the surviving child instead of dropping the centering —
> see the sibling `next-tailwind` example's `FlattenDemo` for that exact case.

### In the built bundle

After `npm run build`, the optimized classes are visible directly in the emitted JS:

```bash
grep -o 'size-full\|inset-0\|size-8\|p-4' dist/assets/*.js   # the compressed forms
grep -o 'w-full h-full\|top-0 right-0 bottom-0 left-0\|w-8 h-8' dist/assets/*.js  # gone
```

The first command finds the compressed classes; the second finds nothing — the
verbose forms are no longer shipped. You can also run `npm run preview`, open the
app, and count the nodes under `#root` in devtools' Elements panel, then toggle the
plugin off in `vite.config.ts` to compare before/after.
