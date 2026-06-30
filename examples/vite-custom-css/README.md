# domflax — Vite + React + custom CSS

A runnable example that wires [`domflax`](../../packages/domflax) into a plain
**Vite + React** app (no Tailwind) using the **custom-CSS provider**. It shows
domflax resolving class names against a hand-written stylesheet and flattening
redundant wrapper elements, and it documents the **selector-safety** rule that is
meant to stop it from removing wrappers a CSS selector depends on.

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

domflax must be **built first** (the example consumes its `dist/`). From the repo root:

```bash
# 1. Build the domflax package (produces packages/domflax/dist)
npm run build -w domflax

# 2. Install + run this example
cd examples/vite-custom-css
npm install
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

### Case 1 — centering wrapper (flattens)

```jsx
<div className="center">       {/* only job: flex-center its child */}
  <div className="card"> … </div>
</div>
```

domflax recognizes the centering signature of `.center` from `styles.css` and **removes
the wrapper**, leaving just the `.card`. Fewer DOM nodes for the same content.

### Case 2 — combinator-dependent wrapper (selector-safety)

```jsx
<div className="list">
  <div className="item">        {/* looks like removable noise … */}
    <h3>…</h3>                  {/* … but `.list > .item h3` colors this crimson */}
  </div>
</div>
```

The rule `.list > .item h3 { color: crimson }` makes the heading crimson **only while the
`.item` wrapper sits directly inside `.list`**. By design, domflax's selector-safety guard
should detect that `.item`/`.list` are *load-bearing* for this combinator selector and
**refuse to flatten them**, even though they paint nothing themselves — removing them would
silently change the rendered color.

## Current status (v0) — important

domflax is at **v0** (see the package roadmap). The custom-CSS provider, the flatten
patterns, and the selector-safety analysis at the *resolver* level are implemented, but
**the selector-safety analysis is not yet wired into the bundler pipeline.** Concretely,
the build adapter runs the pass manager with a *null* selector index and the JSX frontend
does not yet stamp the "targeted by a combinator" flag onto elements from the resolver's
complex-selector list. (Roadmap item: *"CSS selector-safety analysis — don't break
`div div h1`, `:nth-child`."*)

As a result, **what you observe today differs from the intended design** in two ways:

1. **Case 2 is not yet protected.** With the current build, the `.item` (and `.list`)
   wrappers are *also* flattened, because the guard that would preserve them is not
   connected to the build pipeline. Once selector-safety is wired in, this example
   becomes a working demonstration that the wrapper is preserved.
2. **Case 1 loses its centering.** When the `.center` wrapper is removed, domflax wants
   to re-emit `place-self:center` onto the card — but the custom-CSS provider can only
   emit class names that already exist in your stylesheets, and there is no such class
   here, so the centering is dropped rather than re-applied.

Both points are honest reflections of the current engine; they are tracked by the v0
roadmap and the example is structured so it demonstrates the *intended* behavior as soon
as those passes land. The app itself is structurally complete, type-correct, and builds
cleanly with `npm run build`.
