# static-html (CLI, custom CSS)

A plain built static page — no framework, no build step — optimized by the domflax **CLI**. It shows what domflax does to real `.html`:

- **Inert-wrapper flatten** — `<div class="wrap"><div>…</div></div>` (a `display:contents` wrapper + an empty `<div>`) are both removed; the real `<span class="badge">` survives in place.
- **Selector-safety** — `styles.css` has `.panel > .row h3 { … }`, so the `.panel` and `.row` wrappers are **preserved** (removing them would break that rule).
- **Per-page CSS, auto-detected** — the run below passes **no `--css`**: domflax reads this page's own `<link rel="stylesheet" href="styles.css">` and resolves against it.
- **Byte-for-byte outside edits** — doctype, comments, whitespace, and untouched tags are unchanged.

## Run it

```bash
# from this folder — writes an optimized copy to ./optimized (source is never touched)
npx domflax ./index.html --provider custom --out ./optimized
```

Output (`optimized/index.html`) — the two inert wrappers are gone, `.panel`/`.row` remain:

```
domflax: optimized 1 of 1 file (2 nodes removed, 1 classes saved, 35 bytes saved).
```

For a **whole site**, point domflax at the folder — it processes every `.html` across CPU cores with a memory-bounded pool (`--max-memory <MB>` caps RAM, never OOM):

```bash
npx domflax ./dist --provider custom --out ./dist-optimized --max-memory 1024
```

> Centering wrappers (`flex`/`grid` + `items-center justify-center`) flatten to `place-self:center` under a `grid` parent when the provider can emit that class (e.g. Tailwind's `place-self-center`). With hand-written custom CSS that doesn't expose such a class, the wrapper is safely preserved.
