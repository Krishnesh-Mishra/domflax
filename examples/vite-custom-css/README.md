# domflax — Vite + React + custom CSS

A runnable example that wires [`domflax`](../../packages/domflax) into a plain
**Vite + React** app (no Tailwind) using the **custom-CSS provider**. It shows
domflax resolving class names against a hand-written stylesheet, and it demonstrates
the two **safety guarantees** that stop it from removing a wrapper when doing so would
change the rendering: **selector-safety** (a wrapper a CSS combinator depends on) and
**residual-skip** (a centering wrapper whose residual style has no class to land on).

> This example is **standalone** — it is not a workspace member. It depends on the
> local `domflax` package via `"domflax": "file:../../packages/domflax"`.

## What the custom-CSS provider does

With `provider: 'custom'`, domflax does **not** use Tailwind. Instead it parses the
stylesheets you list in `cssFiles` (via `postcss` + `postcss-selector-parser`) and
builds two maps from them:

- **forward** (`class → computed style`): so it can tell what each `className`
  actually paints/lays out, e.g. that `.center` is `display:flex; align-items:center;
  justify-content:center` — a centering wrapper.
- **reverse** (`computed style → class`): so any styles it pushes onto another element
  can be re-emitted as existing class names from your CSS.

It also records **selector participation** for every class (is it the subject of a
rule? an ancestor in a combinator? a sibling? inside `:has()`? a structural pseudo?)
and the set of **complex selectors** (anything with a combinator like `>`/`+`/`~` or a
structural pseudo). That information is what the selector-safety guard is designed to
consume.

## Files

| File | Purpose |
| --- | --- |
| `vite.config.ts` | Registers `domflax.vite({ provider: 'custom', cssFiles: ['./src/styles.css'] })` **before** `@vitejs/plugin-react`. |
| `src/styles.css` | Hand-written CSS: `.center`, `.card`, `.muted`, `.item`, and the combinator rule `.list > .item h3`. |
| `src/App.tsx` | Two demo structures: a flatten candidate and a selector-safety candidate. |
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
`src/App.tsx`.

Both cases below demonstrate domflax's **safety guarantees** for the custom-CSS
provider: in this stylesheet, *neither* wrapper can be safely removed, and domflax
correctly preserves both. (For a case where flattening *does* happen and the child
gains `place-self-center`, see the sibling `vite-react-tailwind` / `next-tailwind`
Tailwind examples.)

### Case 1 — centering wrapper (preserved by residual-skip)

```jsx
<div className="center">       {/* only job: flex-center its child */}
  <div className="card"> … </div>
</div>
```

`.center` has the centering signature domflax recognizes, so it is a flatten
*candidate*. But removing it would leave a residual `place-self:center` that has to
land on the surviving `.card` — and the custom-CSS provider can only emit class names
that already exist in your stylesheets, and there is **no class** here that maps to
`place-self:center`. Rather than silently drop the centering (which would move the
card), domflax's **residual-skip** guard cancels the flatten and **keeps the
`.center` wrapper**. Pixels unchanged.

### Case 2 — combinator-dependent wrapper (selector-safety)

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

## What you observe today

Both guarantees are now wired into the build pipeline. Running the transform on
`src/App.tsx` (or inspecting the built output / served DOM) shows that:

1. **Case 1 — `.center` is preserved** (residual-skip): the wrapper survives because
   the residual `place-self:center` has no class to carry it in this stylesheet.
2. **Case 2 — `.item` and `.list` are preserved** (selector-safety): the
   `.list > .item h3` combinator depends on them.

Run the transform yourself to confirm — the output is byte-for-byte the authored
JSX shape (both wrappers intact), proving domflax declined to flatten:

```bash
node --input-type=module -e "
import * as domflax from 'domflax';
import { readFileSync } from 'node:fs';
const eng = domflax.createDomflax({ provider: 'custom', cssFiles: ['./src/styles.css'] });
console.log(eng.transform(readFileSync('src/App.tsx','utf8'), process.cwd()+'/src/App.tsx').code);
"
```

The app is structurally complete, type-correct, builds cleanly with `npm run build`,
and renders identically with the plugin active.
