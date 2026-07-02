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

### Q19c. One file per pattern: definition + tests in a single `definePattern({…, test})` call
**Decision:** A pattern is authored as ONE `definePattern({ name, safety, doc, match, rewrite, test })`
call with `export default` — one import, no separate `*.test.ts`, no manual registration. `test`
holds the spec declaratively (`cases: [{before, after}]`, `noMatch: […]`, optional `provider`/
`contexts`, and a rare `custom(ctx)` escape hatch). The single generic harness iterates
`builtinPatterns`, runs each pattern's `test` through the REAL transform, and applies the automatic
invariant suite (purity, no-cross-opaque, id-preservation, safety ceiling, termination) — no
per-pattern spec needed. **Why:** single source of truth (no definition↔test drift), near-zero
marginal cost per pattern, and tests-as-data the harness can introspect/extend (report, fuzz, feed the
maintainer verifier). `definePattern` is THE declarative function (absorbs the old `pattern()`); raw
`match`/`rewrite` fns remain escape hatches. This supersedes the earlier separate-`examples`+separate-
test-file approach and simplifies the test-folder restructure (no per-pattern test files remain).

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

### Q22b. Should the build-time transform gate risky flattens with a headless-Chromium equivalence check?
**Decision:** **No — the user-facing transform is STATIC-ONLY and never launches a browser.** We first
built a verifier-gated mode (render before/after, commit only if identical), then removed it from user
builds. **Why:** (1) rendering at build time is fragile (flaky, heavy, env-dependent); (2) more
fundamentally, the equivalence that matters for context-dependent flattens (`place-self` needs a
flex/grid parent) is a *runtime composition* property — rendering an *isolated* snippet in a neutral
page can't know the real parent, so it would conservatively reject the same cases static analysis
already skips → a browser dependency for ~no gain. **What we do instead:** a static classifier
(`provably-safe` vs `needs-verification`); provably-safe flattens (passthrough/empty/display-contents/
redundant-fragment, and centering only when the parent is *statically* flex/grid and no styles drop)
are applied; everything else is **skipped** (conservative, sound, fast, zero browser). The
`@domflax/verify` Chromium tool remains a **maintainer-side** pattern-testing aid + an optional
standalone `domflax/verify` export — never in the transform path. Cross-file/framework-aware context
inference (Astro static, Next layouts) is a possible future frontend enhancement, not a general
mechanism (undecidable for arbitrary React composition; breaks incremental builds).

### Q23. Why didn't 85 green tests catch that?
**Decision:** Because tests ran against **source**, not the **built dist**. Add **dist-level smoke
tests** that build then `require` `domflax/dist` and assert the real transform output — source-passing
is necessary but not sufficient; what users install is the dist. This is now a standing gate.

## H. Licensing
The project ships under the **Domflax Software License (DSL-1.0)** (FSL-style: source-available, time
-delayed conversion to Apache-2.0), with a **Runtime Exception** placing `domflax/runtime`,
`domflax/cli`, and the pattern library under MIT (they embed into user bundles). See [LICENSE](../LICENSE).

## I. HTML frontend/backend (parse5)

### Q24. How does the `.html`/`.htm` frontend optimize HTML without reformatting the document?
**Decision:** A dedicated `@domflax/frontend-html` frontend/backend pair that reuses the exact same
IR / passes / resolver / safety machinery as the JSX path — only the parser differs (**parse5**
instead of Babel). It does the same job the JSX frontend does, via **source-span surgical edits**, so
untouched bytes are preserved **byte-for-byte**.

- **Parse (parse5 → IR).** `parse5.parse(code, { sourceCodeLocationInfo: true })`, then a tree walk
  lowers each element → `IRElement` (tag + non-`class` attributes; the `class` attribute is resolved
  through `ctx.resolver` + `ctx.normalizer` onto `computed` so patterns match on resolved style),
  text → `IRText`, comments → `IRComment`. Doctype and the auto-inserted `<html>/<head>/<body>`
  wrappers are **preserved verbatim** (doctype is never represented; synthetic wrappers become
  opaque). Precise **source spans** (element span, open-/close-tag spans, and the `class` VALUE span
  incl. quotes) are recorded in the `BackrefTable` — the parse5 attr location tolerates both the v6
  (top-level `attrs`) and v7 (`startTag.attrs`) layouts.
- **Print (surgical, never re-serialize).** A `magic-string` is built over the ORIGINAL source; the
  backend only edits changed spans — overwrite a `class` VALUE span to rewrite tokens in place, and
  unwrap a flattened wrapper by deleting **just** its open- and close-tag spans (children survive
  verbatim). Re-serializing the parse5 tree is deliberately avoided (it would normalize
  quoting/whitespace/attribute order across the whole file).
- **Opaque set (never flatten/rewrite),** enforced with `meta.safetyFloor = 0` (the applier refuses
  every op above lint): elements with an `id` (JS `querySelector`/anchor hook), any inline `on*=`
  handler, or `contenteditable` (element only); and the `<script>/<style>/<template>/<svg>/<pre>/
  <textarea>` subtrees (not descended into). Non-`class` attributes land in the `AttrMap`, so the
  existing flatten `hasOwnAttrs` guard already refuses to unwrap an `id`/`data-*` wrapper.
- **Lazy parse5.** `Frontend.parse` is synchronous, so parse5 is loaded via `createRequire(import.
  meta.url)('parse5')` INSIDE `parse()` (not a top-level import) — the JSX-only path never pulls
  parse5 into memory. parse5 v7 ships a CJS build under its `require` export, so the require resolves
  cleanly in both the ESM and CJS outputs (and when bundled into `domflax`).
- **Same conservative safety.** The `'provably-safe'` gate and the flatten classifier are unchanged;
  centering/flex wrappers stay preserved (context-aware centering is a separate future task).

## J. Shared config + audit mode (0.3.0 round 1)

### Q25. How is domflax configured across the CLI and the build plugins without two option schemas?
**Decision:** ONE exported type — **`DomflaxConfig`** (`import type { DomflaxConfig } from 'domflax'`)
— is the union of the plugin options (`provider`, `cssFiles`, `include`, `safety`, `dryRun`, `audit`)
and the CLI options (`out`, `css`, `report`, `details`, `passes`, `projectRoot`, `maxMemory`,
`concurrency`). `DomflaxOptions` (the `vite()`/`webpack()`/`createDomflax()` parameter) **extends**
it, so a typed shared config object spreads straight into any adapter. `css`/`cssFiles` are aliases
(CLI vs plugin spelling); the CLI spelling wins when both are set.

- **Config file:** `domflax.config.{js,mjs,cjs,json}`, discovered UPWARD from `projectRoot`/cwd —
  nearest file wins; the walk stops at the filesystem root or the first `package.json` boundary
  (a config sitting next to that `package.json` is still found). No cosmiconfig — `existsSync`
  walk + native `require` (Node ≥ 20.19 `require(esm)` covers `.mjs`/ESM `.js`; a clear error
  suggests `.cjs`/`.json` on older Node) + `JSON.parse`. Both `export default {...}` and
  `module.exports = {...}` are accepted; `defineConfig()` (identity) gives IntelliSense.
- **Precedence (everywhere):** explicit flags / inline options > config file > defaults. The CLI
  re-parses argv with the file config underneath (`parseInvocation(argv, fileConfig)`); the plugins
  merge via `withConfigFile()` ONCE at factory time and forward `configFile: false` (e.g. into the
  webpack loader options) so discovery never runs twice. `configFile: false` disables discovery;
  a string loads that exact file.
- **Never from a file (flags only, safety):** `--dangerously-overwrite-source`, `--no-git-check`,
  `--yes`/`--no-interactive`. The wizard pre-fills its choices from the merged options.
- **Layering:** the shared machinery lives in `@domflax/cli` (`config-file.ts`, subpath-exported)
  because the CLI cannot import the `domflax` meta package (bin cycle) while `domflax` already
  bundles `@domflax/cli` — same pattern as the pool worker.

### Q26. What does `--audit` / `audit: true` do, and how is the score computed?
**Decision:** Audit is "dry-run with a verdict": the FULL transform pipeline runs, but NOTHING is
written (`--out` is ignored; plugins pass every module through byte-identical) and one boxed report
is printed — a **0–100 DOM-efficiency score**, aggregate potential (files improvable, nodes
removable, classes compressible, bytes savable) and the top 5 worst files by savable bytes.

- **Formula:** `byteRatio = bytesSavable / max(1, bytesTotal)`;
  `nodeRatio = nodesRemovable / max(1, nodesTotal)`;
  `score = round(100 × (1 − byteRatio) × (1 − nodeRatio))`, clamped to [0, 100]. 100 ⇔ nothing to
  improve; the two waste dimensions (markup weight, removable DOM) scale multiplicatively.
  Per-file negative byte deltas clamp to 0 so a pathological file can't inflate the score.
- **Plumbing (extend, not duplicate):** `FileStatDelta` gained the BEFORE totals
  (`nodesBefore`/`bytesBefore`) as score denominators; the CLI reuses `FileStats` via
  `auditStatsFromFile`. Shared accumulator/score/renderer live in `@domflax/cli/audit`; webpack
  bridges loader → plugin through `Symbol.for('domflax.auditTotals')` on the compilation (same
  design as the summary bridge). The CLI pool path audits too — workers already return stats; in
  audit mode they simply skip the write, so large batches stay parallel.
- **Safety:** audit forces dry-run semantics (no write plan is exercised, the overwrite git gate is
  moot) and the wizard offers it as an output mode ("Audit — score only, write nothing").

## K. Static extraction for dynamic classNames (0.3.0 round 2)

### Q27. Can `className={cn("px-4 py-4", cond && "bg-red-500")}` / template-literal classNames be compressed at all, given they're dynamic?
**Decision:** Yes — **segment-locally**. A recognized class-combiner call (`cn`, `clsx`,
`classNames`, `classnames`, `twMerge`, `twJoin`; overridable via frontend config `classCallees` —
`cva` deliberately excluded, its args are variant configs) or an untagged template literal is
lowered into MIXED segments: each plain string-literal argument / template quasi becomes a STATIC
segment with a precise splice span (string CONTENTS, quotes/backticks/`${}` excluded); every other
argument and every `${expr}` hole stays a DYNAMIC segment (opaque, byte-preserved). In shadcn-style
apps ~25 % of classNames are this shape with mostly-static tokens.

- **Order-safety rule (the correctness core):** `cn`/`twMerge` resolve conflicts by ORDER (later
  wins) and any dynamic segment can add/override classes at runtime. So a rewrite happens ONLY
  within one static segment, replacing its tokens with a shorter set that **re-resolves to exactly
  the same computed style** (normalizer.equals backstop) in the **same argument position** —
  `cn("px-4 py-4", cond && "p-2")` → `cn("p-4", cond && "p-2")` keeps every later-wins
  relationship. Never merge across segments, never reorder segments, never touch dynamic segments,
  never emit a longer set.
- **Flatten stays blocked:** the mixed list keeps `hasDynamic: true` (full class set unknown), so
  `hasDynamicClasses`-gated flatten patterns and the whole-element compress path skip the element
  exactly as before. Static tokens DO resolve onto `computed` now (partial style) — only ever
  ADDING style facts, which is strictly more conservative for the flatten guards.
- **When in doubt, bytes untouched:** a segment with an unresolved token (`js-hook`, typo,
  undriveable Tailwind) is skipped whole; non-droppable tokens (variants, selector-bound) are
  retained verbatim with the residual-subtraction emit compressing around them; string literals
  with escape sequences and template quasis with a partial token at a `${}` boundary
  (`` `px-${n}` ``) are demoted to dynamic; an unknown wrapper fn (`myCn(...)`) stays fully opaque.
- **Placement:** frontend split lives in `@domflax/frontend-jsx/frontend-classlist`; the
  segment-local compress in `@domflax/core/segment-compress`, invoked from
  `syncClassesFromComputed` — so the meta package, the build plugins, and the CLI all get it from
  the one shared reverse-emit step. The JSX backend splices each rewritten segment via its own
  span, preserving the segment's leading/trailing whitespace (a template chunk's boundary space is
  the token separator against the neighbouring `${expr}`).

## L. Compress-engine upgrades: arbitrary values, variants, inline styles (0.3.0 round 3)

**Q: The forward engine resolves `h-[40px]` fine, but the reverse side only searched the enumerable
class list — `h-[40px] w-[40px]` could never fold to `size-[40px]`. How do we propose candidates we
cannot enumerate?**

- **Synthesis + mandatory round-trip.** For one-property families with a known stem mapping
  (padding/margin sides, `w`/`h`/`size`, `gap`/`gap-x`/`gap-y`, inset sides + `top/right/bottom/left`,
  `rounded`) the cover builder PROPOSES `stem-[value]` candidates for the exact values a target block
  asks for (`resolver-tailwind/synthesize.ts`). A proposal is only a candidate: it is generated
  through the REAL engine (v3 JIT compiles any candidate; the v4 snapshot engine batches all misses
  into ONE `candidatesToCss` bridge call via `TwEngine.prime`) and admitted only when its resolved,
  normalized tuples equal the intended declarations EXACTLY. A bogus synth (engine says 41px, we
  wanted 40px) is silently discarded. Cost is inherent — the DP minimizes token length, so an
  enumerated `p-4` always beats `p-[1rem]` when the value is on the scale.
- **Why not convert px↔rem?** Never: root font-size is a runtime fact. `style={{padding:16}}`
  converts to `p-[16px]`, not `p-4`; only a literal `1rem` matches `p-4`.

**Q: Variant tokens (`hover:px-4 hover:py-4`) were retained verbatim (opaque for compress). How do
we compress WITHIN a variant chain without ever mixing chains or dropping a hover style?**

- **The normalized condition key IS the chain identity.** Each `StyleMap` condition block is one
  group; candidates for a non-base block are enumerated + synthesized utilities RE-PREFIXED with
  that block's exact chain, at full prefixed cost. Chains are LEARNED, never assumed: a token like
  `hover:px-4` teaches `conditionKey ↔ 'hover:'` only after a round-trip proof (root resolves
  BASE-only, full token resolves to the root's declarations under exactly one condition). `before:`
  utilities fail the proof (they inject `content`) and stay verbatim; unknown variants resolve to
  nothing and are retained as unresolved tokens. Because no candidate spans two conditions, the
  exact cover decomposes into independent per-block DP solves.
- **Droppability got a second tier, not a loosened gate.** `SelectorUsage.rebuildable` marks a
  validated variant token; reverse-emit/segment-compress may drop such tokens ONLY in a first
  attempt that carries a MANDATORY re-resolve equality backstop (style-dirty elements included);
  any mismatch falls back to the historical droppable-only pass byte-for-byte. `EmitContext.sourceTokens`
  feeds the element's own droppable tokens into the cover as candidates, so feasibility is
  guaranteed and the rewrite can never be worse than the original.

**Q: A static `style` attribute beats EVERY selector. When is `style="padding:16px"` → `class="… p-4"`
provably render-neutral?**

- **Only when the element's own fully-resolved classes are the only competing source.** The
  converter (`core/style-to-class.ts`, invoked from `syncClassesFromComputed`) merges the static
  style declarations over the class-derived style and asks the cover for one combined target. It
  skips: any unknown/opaque class token, any property a NON-BASE condition block also sets (inline
  used to beat `hover:p-2` unconditionally), `!important`, custom properties (`--*`, descendants may
  read them), spread attrs/components/floor-0 nodes, and — for the custom-CSS provider — any
  property flagged by the new `StyleResolver.competesWith` (a bare `div { padding: 4px }`, universal,
  combinator, compound, id/attr subject also setting it; conservative superset matching, `true` only
  suppresses). Tailwind omits `competesWith` — its whole modelled surface is class-keyed.
- **Two hard gates before any byte moves:** the rewritten class set must RE-RESOLVE to the exact
  combined target (normalizer-equal), and total bytes (class attr + remaining style attr) must
  STRICTLY shrink. Surviving declarations stay inline VERBATIM (author text preserved per raw decl);
  an emptied attribute is removed (span + separating whitespace) by surgical backend splices in both
  frontends. The attribute also STAYS in `attrs` at parse time, so flatten guards keep treating
  styled wrappers as non-inert.
