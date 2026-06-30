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
   onto the child and drops the wrapper. Empty single-child wrappers (including the
   per-row wrapper inside the `.map(...)` list) are removed too.
2. **Compress** — collapses verbose class/style sets into minimal equivalents
   (e.g. `px-4 py-4` → `p-4`, `top-0 right-0 bottom-0 left-0` → `inset-0`).

Matching happens on **computed styles**, not raw class names, and dynamic content
(`{expr}`, components, `.map()` data) is treated as opaque and preserved — so the
list keeps its stable React `key`s and its data.

> ⚠️ Status (domflax v0 — important). domflax is an early scaffold. As of the
> pinned snapshot in `../../packages/domflax`, the JSX frontend/backend does **not**
> yet round-trip a full module: its `transform` emits only the JSX it finds and
> drops the surrounding code (imports, function declarations, the `render()` call,
> `export default`). In practice that means the build **succeeds** but the rendered
> app is currently broken when the plugin is active — this is a known limitation of
> domflax's incomplete backend, not of this example. The example is wired exactly as
> domflax intends and will work end-to-end once the backend round-trips whole files.
>
> To preview the app's UI in the meantime, comment out the `domflax.vite(...)` line
> in `vite.config.ts` and re-run `npm run dev`.

## Run it

domflax must be **built first** (the example consumes its `dist/`). From the repo
root (`flaxe/`):

```bash
npm install                 # once, at the repo root (installs workspace deps)
npm run build -w domflax    # build domflax's dist/ that this example imports
```

> Another process in this repo may also be rebuilding domflax; if you hit a
> transient error here, just run the build command once more.

Then, in **this directory** (`examples/vite-react-tailwind/`):

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

What you should look for, once the backend round-trips full modules (see the Status
note above):

- **Flatten — fewer DOM nodes.** The full-size `flex justify-center items-center`
  centering wrapper and the empty single-child wrappers (including the per-row
  wrapper inside the `.map(...)`) collapse away; the centering intent moves onto the
  child as `place-self:center`. The list keeps its stable React `key`s and dynamic
  content untouched.
- **Compress — shorter class sets.** `px-4 py-4` → `p-4`,
  `top-0 right-0 bottom-0 left-0` → `inset-0`, etc.

Once the app renders, you can also count nodes under `#root` in devtools' Elements
panel and toggle the plugin off in `vite.config.ts` to see the before/after diff, or
read the compiled `dist/assets/*.js` after `npm run build`.
