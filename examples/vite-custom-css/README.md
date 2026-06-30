# domflax — Vite + React + custom CSS

A runnable example that wires [`domflax`](../../packages/domflax) into a plain
**Vite + React** app (no Tailwind) using the **custom-CSS provider**. It shows
domflax resolving class names against a hand-written stylesheet, flattening the
wrappers it can prove are inert, and **preserving** the two kinds of wrapper it must
not touch: one a CSS combinator depends on (**selector-safety**), and a flex
**centering** wrapper (**conservatively preserved**).

> This example is **standalone** — it is not a workspace member. It depends on the
> local `domflax` package via `"domflax": "file:../../packages/domflax"`.

## What the custom-CSS provider does

With `provider: 'custom'`, domflax does **not** use Tailwind. Instead it parses the
stylesheets you list in `cssFiles` (via `postcss` + `postcss-selector-parser`) and
builds two maps from them:

- **forward** (`class → computed style`): so it can tell what each `className`
  actually paints/lays out — e.g. that `.contents` is `display:contents` (an inert
  wrapper) while `.center` is `display:flex; align-items:center; justify-content:center`
  (a centering wrapper).
- **reverse** (`computed style → class`): so any styles it pushes onto another element
  can be re-emitted as existing class names from your CSS.

It also records **selector participation** for every class (is it the subject of a
rule? an ancestor in a combinator? a sibling? inside `:has()`? a structural pseudo?)
and the set of **complex selectors** (anything with a combinator like `>`/`+`/`~`).
That information is what the selector-safety guard consumes.

## Files

| File | Purpose |
| --- | --- |
| `vite.config.ts` | Registers `domflax.vite({ provider: 'custom', cssFiles: ['./src/styles.css'] })` **before** `@vitejs/plugin-react`. |
| `src/styles.css` | Hand-written CSS: `.center`, `.card`, `.muted`, `.contents`, `.list-plain`, `.item`, and the combinator rule `.list > .item h3`. |
| `src/App.tsx` | Three demo structures: an inert-wrapper flatten, a selector-safety preserve, and a centering preserve. |
| `src/main.tsx` | React entry point. |
| `index.html` | Vite HTML entry. |

> **Import note:** domflax's bundler adapters (`vite`, `webpack`) are *named* exports;
> the *default* export is the programmatic `createDomflax` factory. To call
> `domflax.vite(...)` from a single binding, this example uses
> `import * as domflax from 'domflax'`.

## How to run

The example consumes domflax's `dist/` via the `file:../../packages/domflax` link
(already built). In **this directory** (`examples/vite-custom-css/`):

```bash
npm install      # installs react/vite + the file: link to domflax
npm run dev      # dev server
npm run build    # production build
```

> The custom-CSS provider needs `postcss` and `postcss-selector-parser` (they are
> *optional* peers of `domflax`, loaded only when `provider: 'custom'` is used). They
> are already listed in this example's `devDependencies`, so `npm install` pulls them in.

## What to observe

`domflax` runs as an `enforce: 'pre'` source transform on `.jsx`/`.tsx` **before** React's
JSX→`createElement` lowering. The clearest way to see its effect is to run `npm run dev`,
open the app, and inspect the rendered DOM in your browser devtools — then compare it to
`src/App.tsx`. `src/App.tsx` shows three cases.

### Case A — inert wrappers are flattened (incl. inside `.map`)

```jsx
<div className="contents">     {/* display:contents — no box, paints nothing */}
  <div>                        {/* empty style-less wrapper */}
    <p className="muted">…</p>
  </div>
</div>
```

`.contents` is `display:contents` and the inner `<div>` is style-less; neither
establishes a layout context or paints anything, so domflax **removes both** and
hoists the `<p>`. The same happens to the inert wrapper `<div>` inside each
`.map(...)` row — **list rows are optimized in 0.1.1** — while the dynamic
`{it.name}` text and the React `key`s are preserved.

### Case B — combinator-dependent wrapper is preserved (selector-safety)

```jsx
<div className="list">
  <div className="item">        {/* looks like removable noise … */}
    <h3>…</h3>                  {/* … but `.list > .item h3` colors this crimson */}
  </div>
</div>
```

The rule `.list > .item h3 { color: crimson }` makes the heading crimson **only while the
`.item` wrapper sits directly inside `.list`**. domflax's selector-safety guard detects
that `.item`/`.list` are *load-bearing* for this combinator selector and **refuses to
flatten them**, even though they paint nothing themselves — removing them would silently
change the rendered color.

### Case C — flex centering wrapper is preserved (conservative)

```jsx
<div className="center">       {/* only job: flex-center its child */}
  <div className="card"> … </div>
</div>
```

`.center` has the centering signature domflax recognizes — but a flex/grid wrapper
**establishes its child's layout context**, so removing it cannot be statically proven
render-identical. domflax therefore **conservatively keeps it**, and emits **no
`place-self-center`**. Context-aware or opt-in-verified flattening of centering
wrappers is a [Roadmap](../../README.md#roadmap) item.

## Verify it yourself

Run the transform on `src/App.tsx` and you will see the inert wrappers gone and both
preserved wrappers intact:

```bash
node --input-type=module -e "
import * as domflax from 'domflax';
import { readFileSync } from 'node:fs';
const eng = domflax.createDomflax({ provider: 'custom', cssFiles: ['./src/styles.css'] });
console.log(eng.transform(readFileSync('src/App.tsx','utf8'), process.cwd()+'/src/App.tsx').code);
"
```

### In the built bundle

After `npm run build`, the preserved wrappers' class names survive in the emitted JS,
while the inert `.contents` wrapper's class is gone (it was flattened away):

```bash
grep -oh '"center"\|"item"\|"list"\|"list-plain"' dist/assets/*.js | sort | uniq -c   # preserved
grep -oh '"contents"' dist/assets/*.js                                                # flattened — nothing
```

Observed output of the first command:

```
      1 "center"
      1 "item"
      1 "list"
      1 "list-plain"
```

The second command finds **nothing**: the `display:contents` wrapper was removed, so
its class string is no longer shipped. The app builds cleanly with `npm run build` and
renders identically with the plugin active.
