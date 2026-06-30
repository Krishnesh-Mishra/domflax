# domflax example — Vite + React + Tailwind

A small, standalone app that runs [domflax](../../packages/domflax) as a Vite build
plugin. It is intentionally written the "verbose" way — long class sets like
`px-4 py-4`, an inert `display:contents` wrapper, and a flex-centering shell — so you
can watch domflax shrink the markup at build time **without changing the rendered
UI**.

This example is **not** a workspace member; it has its own `package.json` and
references domflax via `"domflax": "file:../../packages/domflax"`.

## What the plugin does (domflax 0.1.1)

domflax analyzes your JSX at build time, matching on **computed styles** (not raw
class names), and rewrites it to the smallest equivalent shape. It is **conservative
and static-only**: it only makes a change it can prove is render-identical.

1. **Compress — shorter class sets.** Verbose, equivalent utility sets collapse to
   their shortest form: `px-4 py-4` → `p-4`, `mt-2 mb-2` → `my-2`,
   `h-10 w-10` → `size-10`, `w-full h-full` → `size-full`. This works **even on an
   element with a dynamic `{expr}` child** (the `<Counter>` swatch, `size-10`) and
   **even inside `.map(...)` list rows** (the feature list rows, `p-4`).
2. **Flatten — fewer DOM nodes (inert wrappers only).** Wrappers that establish no
   layout context and paint nothing are removed and their children hoisted:
   `display:contents` wrappers and empty/style-less `<div>`s. In this app the
   single-child `display:contents` wrapper around the `<ul>` and the bare `<div>`
   inside each `.map(...)` row are both dropped.

Dynamic content (`{expr}`, components, `.map()` data) is treated as **opaque and
preserved** — the list keeps its stable React `key`s and its data, and only the
*static* class set / wrapper shape around it is rewritten.

### What it does *not* do: flex/grid centering wrappers are preserved

domflax does **not** flatten flex/grid **centering** wrappers. A flex/grid wrapper
establishes its child's layout context, so removing it cannot be statically proven
render-identical — domflax **conservatively preserves it**. The
`<div className="w-full h-full flex justify-center items-center bg-slate-100">` shell
in `src/App.tsx` is therefore **kept** (it is only *compressed* to
`size-full flex justify-center items-center bg-slate-100`, never removed). There is
no `place-self-center` in the output. Context-aware/opt-in-verified flattening of
those wrappers is a [Roadmap](../../README.md#roadmap) item.

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

- **Compress.** `<Card>`'s `px-4 py-4` → `p-4`; the description `<p>`'s
  `px-4 py-4 … mt-2 mb-2` → `p-4 … my-2`; `<Counter>`'s `h-10 w-10` → `size-10`
  (with its dynamic `{count}` child preserved); each `.map(...)` row's
  `px-4 py-4` → `p-4`.
- **Flatten.** The single-child `display:contents` wrapper around the `<ul>` is
  removed, and the bare `<div>` inside each `.map(...)` row is removed — the stable
  React `key`s and dynamic `{f.*}` content survive.
- **Preserved.** `<App>`'s flex-centering shell stays (only `w-full h-full` →
  `size-full`); no wrapper is dropped and no `place-self-center` is emitted.

### In the built bundle

After `npm run build`, the optimized classes are visible directly in the emitted JS:

```bash
grep -oh 'size-full\|size-10\|p-4\|my-2' dist/assets/*.js | sort | uniq -c   # compressed forms
grep -oh 'w-full h-full\|px-4 py-4\|h-10 w-10\|mt-2 mb-2' dist/assets/*.js    # verbose forms — gone
```

Observed output of the first command:

```
      1 my-2
      3 p-4
      1 size-10
      1 size-full
```

The second command finds **nothing** — the verbose forms are no longer shipped. You
can also run `npm run preview`, open the app, and count the nodes under `#root` in
devtools' Elements panel, then toggle the plugin off in `vite.config.ts` to compare
before/after.
