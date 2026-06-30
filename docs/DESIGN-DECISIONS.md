# domflax — Design Decisions (Q&A / rationale log)

> **Purpose.** A living record of *why* domflax is built the way it is — written as the questions
> that came up and the answers we landed on, with alternatives considered and honest limitations.
> If a decision looks wrong to you, the reasoning is here so you can challenge it with a better idea
> rather than re-deriving it from scratch. **Keep appending** new Q&As as decisions are made; never
> silently drop one.
>
> Companion to [ARCHITECTURE.md](./ARCHITECTURE.md). Entries are dated by milestone, newest topics
> grouped by area.

---

## A. Concept & scope

### Q1. Can we turn `<div class="wrapper"><div>x</div></div>` into one div and keep the UI identical?
**Decision:** Yes — "flatten" the redundant wrapper by hoisting its layout intent onto the child
(e.g. a flex-centering wrapper → child gets `place-self:center`). **Why:** fewer DOM nodes = less
to create, lay out, and paint. **Limit:** only when the wrapper paints nothing of its own, has no
behavior attached, and isn't depended on by CSS/selectors (see D-section).

### Q2. Should there also be class/style compression, not just node removal?
**Decision:** Yes — two layers: **flatten** (node count) and **compress** (collapse verbose class
sets, e.g. `px-4 py-4 → p-4`). They compose.

### Q3. Match on class names (`flex justify-center`) or on computed styles?
**Decision:** Match on **normalized computed styles** (`display:flex; place:center`), not class
strings. **Why:** provider-agnostic — the same pattern works for Tailwind, custom CSS, and future
frameworks. If Tailwind is replaced by Bootstrap in 2030, patterns don't get rewritten. **Cost:** we
need a resolver layer (class → style and style → class) per provider.

### Q4. Project name?
**Decision:** **domflax** (DOM + flatten).

---

## B. Distribution & public surface

### Q5. One package or many? Subpaths or separate installs?
**Decision:** Develop as a **monorepo** (`@domflax/*` packages) but **publish exactly one package,
`domflax`**, with the internals bundled in (tsup `noExternal`). Users `npm i -D domflax` and
`import domflax from 'domflax'`. **Why:** clean internal boundaries for us, zero-friction one-install
for users (mirrors how Babel ships). **Alternatives rejected:** publishing `@domflax/*` separately
(more npm surface, version churn) and collapsing the monorepo into one folder (loses boundaries).

### Q6. How do users reach adapters and advanced features?
**Decision:** Bundler adapters are **properties** of the single import (`domflax.vite()`,
`domflax.webpack()`), not subpaths like `domflax/react`. Advanced modules are the only subpaths:
`domflax/pattern-kit` (author patterns), `domflax/verify` (standalone checker), `domflax/runtime`
(browser runtime), plus a `domflax` CLI bin. `playwright` is an **optional peer** (only
`domflax/verify` needs it) so a normal install never downloads a browser.

---

## C. Framework integration

### Q7. A React/Next app ships an almost-empty `index.html` — how can domflax optimize it?
**Decision:** For component frameworks we transform the **`.jsx/.tsx` source** via the bundler's
per-file `transform` hook — one stage *before* JSX becomes `createElement`. We never touch the
shipped `index.html`. **Why:** the optimizable structure lives in the source JSX, not the runtime
DOM. `frontend-jsx` (Babel) handles components; `frontend-html` (parse5) handles real `.html`
(plain HTML / Astro static). **Limit:** **Turbopack** support is pending — it doesn't accept
arbitrary webpack loaders yet.

### Q8. Will Next.js `async` Server Components / data fetching / Suspense break?
**Decision:** No. domflax **never executes code**; it only rewrites static markup shape. `{expr}`
holes, `<Component/>`s, `.map` data, and `dangerouslySetInnerHTML` are **opaque** — preserved
verbatim, never flattened into. No hydration mismatch because server and client compile the same
flattened source.

### Q9. Can the plugin run on Angular/Svelte/etc. since it runs "after compile"?
**Decision:** It runs as a **source transform** (before the framework compiler), not on compiled
output. React/Next/Vite/Remix/Vue/Astro/plain-HTML are good targets. Svelte/Solid already do this
work themselves (skip). Compiled-output (post-framework) transforms are *not* pursued for React —
the structure is gone and the HTML is empty by then.

---

## D. Safety (the trust model)

### Q10. CSS like `div div div h1 {}` — what if a "redundant" wrapper is load-bearing for a selector?
**Decision:** A wrapper is flattenable **only if removing it provably doesn't change any selector's
matched-element set**. We index all complex selectors (combinators, `:nth-child`, `+`/`~`,
`:first/last-child`) and diff matches before/after. **Plain words:** read all the CSS first; if any
rule needs that wrapper, leave it; if unsure, leave it (a missed optimization is free, a broken
layout is not); then double-check by rendering before/after. Tailwind utilities are combinator-free
(near-zero risk); custom/global CSS is the real risk.

### Q11. The `data.map((item,i) => <div>…</div>)` pattern — can we optimize it?
**Decision:** Yes — the **row template** is just JSX in our IR, so flatten/compress apply to it; every
rendered row gets leaner. `.map`, `key`, and `{item.x}` are preserved. New guard: `key` must transfer
to the surviving element or we skip. **We do NOT** auto-convert React lists to template+cloneNode
(see Q13).

### Q12. `innerHTML` / `dangerouslySetInnerHTML`?
**Decision:** Treated as opaque (`hasRawHtml`). We never optimize inside a runtime HTML string and
never break it. (For *dynamic* HTML you control, see the runtime optimizer, Q15.)

---

### Q10b. Does flattening recurse until nothing more can be flattened?
**Decision:** Yes — the flatten pass runs to a **fixpoint**: removing one wrapper can expose a new
opportunity (freed parent, newly-adjacent siblings), so it re-checks and repeats until a full pass
makes zero changes; compress then runs to its own fixpoint. **At BUILD time, not the user's runtime**
— the browser gets the already-minimized DOM and does no per-render recursion. **Terminates** because
each flatten strictly reduces node count (monotonic) + a max-iteration budget backstop;
`runInvariants` asserts no oscillation. **Efficiency:** the production approach is a worklist /
dirty-region re-queue (only re-examine the neighborhood of a mutation), not a full tree re-scan each
iteration — near-linear on large/deeply-nested DOM (perf hardening target).

## E. Runtime techniques

### Q13. `<template>` + `cloneNode` is why Solid is fast — can we bring it to React automatically?
**Decision:** No — **impossible** to do transparently and safely in React, not merely hard. (1) React
never parses HTML, so there's **no parse cost to cache**. (2) React **owns/tracks every DOM node** for
reconciliation, so a callback can't return a cloned real `Element`. The safe React analog of "build
once" is **constant-element hoisting**, not cloneNode. **Where cloneNode IS valid:** plain HTML,
Astro static, vanilla, web components — i.e. wherever the output owns the runtime DOM. There it's an
opt-in, verifier-mandatory `templatize` pass (Stage 3). Solid-level React list speed = Million.js /
Solid island = explicit opt-in with caveats, never transparent.

### Q14. Can parsing be multithreaded (e.g. cores−1) for thousands of files?
**Decision:** Yes. Per-file transform is a pure function → embarrassingly parallel. **CLI mode:** our
own worker pool (`availableParallelism()-1`). **Plugin mode:** the bundler already parallelizes — we
do *not* spawn a pool (avoid oversubscription). Synthetic class names are **content-hashed**, never a
global counter, so parallel output is deterministic. Cross-file optimizations use map-reduce.

### Q15. A one-call runtime optimizer for dynamic HTML before `innerHTML`?
**Decision:** Yes — `domflax/runtime`: a tiny, browser-native, zero-heavy-dep `optimizeHtml(html)`
(sync, content-hash cached, uses the native `<template>` parser) for HTML unknown at build time
(CMS, markdown, fetched fragments). Conservative (no computed styles / no verifier at runtime →
class-pattern + structural rules only). Optional async Web-Worker variant for large payloads only.
**Not a sanitizer** — still use DOMPurify on untrusted input.

---

## F. CLI

### Q16. The CLI shouldn't nuke my `src/`.
**Decision:** Source is **read-only by default**. Output → `--out`/`./domflax-out`, or in place only
inside disposable build dirs. In-place source rewrite needs the explicit
`--dangerously-overwrite-source` flag **plus** a clean git tree; `--dry-run` previews first.

### Q17. Can the CLI be interactive (arrow keys, multiselect) instead of just flags?
**Decision:** Yes — an interactive wizard (`@clack/prompts`) on a no-args run, **TTY-gated** so it
never hangs CI. Flags remain the scriptable path; wizard and flags build the same options object.

---

## G. Patterns & testing (the scalability core)

### Q18. Defining a pattern is too much boilerplate (15 imports, manual style maps, op arrays). Fix?
**Decision:** A declarative `pattern()` API: plain-object `match` (auto-normalized styles), named
rewrite recipes (`flattenInto`, `childGains`, …), and **automatic opacity + selector-safety guards**
for flatten patterns (you can't forget a guard). One import. The verbose `evaluate`/combinator form
stays as the escape hatch for exotic patterns. Compiles down to the existing engine.

### Q19b. Auto-discover patterns by file convention (no manual index)?
**Decision:** Yes — patterns are discovered by the suffix convention `src/**/*.pattern.ts` (any
subfolder, any depth), so adding a pattern = drop one file; no `index.ts` edits, no merge conflicts,
nothing to forget. **How (must be correct for a bundled lib):** a build-time **codegen** step globs
`*.pattern.ts` and writes a generated registry barrel (`src/_registry.generated.ts`) with explicit
imports + the assembled `builtinPatterns` — NOT a runtime `fs` scan (the published package is a
bundle; browsers/bundlers can't `readdir`). Ordering comes from each pattern's declared
`category`/priority, NOT filesystem order (nondeterministic across OSes). Codegen validates unique
names + valid exports. Runs in `prebuild`; a dev watcher regenerates. The generated file is a
gitignored build artifact. Pairs with Q18/Q19: drop a `*.pattern.ts` → auto-discovered → auto-tested
→ CI-Chromium-proven, zero manual wiring.

### Q19. Do we hand-write a test per pattern? Can tests be automatic?
**Decision:** **No hand tests.** Because `match` is structured data, the framework **generates test
inputs from the declaration** (conforming → must transform; guard-violating → must not). The author
optionally adds hints (`examples`, `conditions`, `contexts`, `skipAuto` for raw-fn patterns).

### Q20. Use a Chromium engine to auto-verify patterns? Is that too heavy / safe / does it save time?
**Decision:** Yes, **tiered**, and it runs **in domflax's own build/CI (maintainer-side), not in
end-users' builds**:
- **Tier 0** declaration validation (instant, every pattern).
- **Tier 1** IR invariants + static equivalence (ms, no browser, every pattern always) — catches most
  bugs; scales to thousands in seconds. *Ships in v0.1.0.*
- **Tier 2** synthesized fuzz + **headless Chromium equivalence**, maintainer CI only, run on
  **changed patterns** (content-hash gated) + a sample, batched in one reused browser, verdicts
  cached. *Wired when the verifier lands.*
- **Tier 3** at the **user's** build: cheap **static** selector-safety (reads their CSS, no browser).
  Optional per-user Chromium verify is OFF by default.

**Too heavy?** No — Tier 2 is bounded by *our* pattern count, batched + incremental (seconds–minutes;
seconds day-to-day); end-users pay **zero** Chromium cost. **Safe?** Tier 2 proves pattern *logic* is
sound (on generated contexts); Tier 3 proves safety against a given app's *real* CSS — both needed.
**Honest limit:** synthetic fixtures can't enumerate every real-world ancestor CSS, so build-time
Chromium ≠ universal proof; the per-project static guard covers real context. **Saves author time?**
Yes — authoring collapses to a declaration; CI proves it. **Scale note:** realistically hundreds–low
thousands of patterns (not millions); marginal cost of pattern N ≈ zero.

### Q21. Tailwind resolution for v0.1.0 — real engine or a small table?
**Decision:** **Real tailwindcss engine** (resolve arbitrary classes via the project config), so a
real app's classes actually flatten. The interim curated table was a Stage-1 placeholder.

---

## I. Build & packaging

### Q22. Can we bundle the Tailwind engine into the single `domflax` package?
**Decision:** **No — heavy external engines (tailwindcss, postcss) must NOT be bundled; load them from
the *consumer's* project at runtime.** Discovered during v0.1.0: `@domflax/resolver-tailwind`'s own
dist round-trips correctly, but inlining its source into `domflax` (tsup `noExternal`) broke Tailwind's
deep internals (`createRequire` based on the bundle location) → `emit` silently returned nothing →
the flatten dropped the compensating `place-self-center` class. **Fix:** resolve `tailwindcss` (and
`postcss`) via a require rooted at the user's project (like prettier-plugin-tailwindcss does), make
them **optional peer deps** of `domflax`, loaded **lazily** per provider (custom-CSS-only users don't
pull tailwind, and vice-versa). The pure `@domflax/*` packages are still bundled; only the fragile
engines stay external. **Why optional-peer + lazy:** correctness under bundling + smaller installs.

### Q23. Why didn't 85 green tests catch that?
**Decision:** Because tests ran against **source**, not the **built dist**. Add **dist-level smoke
tests** that build then `require` `domflax/dist` and assert the real transform output — source-passing
is necessary but not sufficient; what users install is the dist. This is now a standing gate.

## H. Licensing
The project ships under the **Domflax Software License (DSL-1.0)** (FSL-style: source-available, time
-delayed conversion to Apache-2.0), with a **Runtime Exception** placing `domflax/runtime`,
`domflax/cli`, and the pattern library under MIT (they embed into user bundles). See [LICENSE](../LICENSE).
