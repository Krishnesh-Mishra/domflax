# domflax — ARCHITECTURE.md (final)

> A build-time DOM optimizer. Two composable layers: **FLATTEN** (remove redundant wrapper
> elements) and **COMPRESS** (collapse verbose class/style sets). The output must render an
> **identical UI** to the source. CI may be slow; runtime must be faster.

This is the final architecture. It reconciles seven subsystem designs and then folds in every
accepted blocker/major fix from the four adversarial reviews (CSS correctness, pattern-authoring
scalability, build/packaging, verifier soundness). §15 lists each review finding with
**accepted/rejected + rationale**; the body sections below already reflect the accepted ones.

---

> **Why is it built this way?** See the companion [DESIGN-DECISIONS.md](./DESIGN-DECISIONS.md) — a
> living Q&A log of every design decision, the alternatives considered, and the honest limitations.
> Read it before challenging a choice (e.g. "why Chromium?", "why not auto-clone React lists?").

## 1. Overview

domflax is a classic three-stage compiler over a single **plain, serializable, framework-agnostic
IR**:

```
FRONTEND (syntax → IR)  |  MIDDLE (passes over IR)  |  BACKEND (IR ops → source)
```

Everything decouples through `@domflax/core`. Load-bearing invariants:

1. **One IR, one document type** (`IRDocument`). No second tree representation.
2. **Patterns match on MEANING, not strings.** Every `IRElement` carries a resolved, normalized
   `computed: StyleMap`. Patterns query `display:flex + center`, never `"flex justify-center"`.
3. **One `StyleMap`, one normalizer.** Resolver, patterns, and verifier share the *same*
   condition-keyed `StyleMap` and the *same* syntactic normalizer instance/version.
4. **Rewrites are data; one trusted applier mutates.** Patterns emit `RewriteOpDraft[]` (plain
   data). The applier in core validates safety + boundary invariants and applies. Rule authors
   **cannot** mutate the IR — enforced at compile time via `DeepReadonly` views, not convention
   (review-2).
5. **Codegen is op-lowering, not reprint.** The backend lowers the applied op log to `TextEdit[]`
   against original spans via `magic-string`. recast is confined to spanless synthesis.

---

## 2. Layered diagram

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  L8  ADAPTERS & TOOLING            unplugin (vite/webpack/rollup/esbuild/rspack/next)  │
│      pkgs: domflax (meta), cli     babel-plugin · CLI (folder auto-detect, plain HTML) │
├─────────────────────────────────────────────────────────────────────────────────────┤
│  L7  ORCHESTRATOR  (pkg: domflax)  transform({code,id,config}) · config resolve+freeze │
│                                    content-hash cache · piscina worker pool · reporter │
│                                    verify-gating (revert, never throw)                 │
├─────────────────────────────────────────────────────────────────────────────────────┤
│  L6  VERIFIER  (pkg: @domflax/verify)   Playwright · ANCESTOR-CONTEXT render · boolean │
│      verdict (bbox|style fail; pixel advisory) · paint-order/stacking check · states   │
│      fuzz-prove (offline, relational+parent-context) · ci-guard (build)                │
├─────────────────────────────────────────────────────────────────────────────────────┤
│  L5  PIPELINE (single file)  (pkg: @domflax/core)   run: parse → passes → codegen      │
├──────────────────────────────────┬────────────────────────────────────────────────────┤
│  L4 FRONTENDS / BACKENDS          │  L3  PATTERN LIBRARY + PATTERN-KIT                  │
│  @domflax/frontend-jsx (babel)    │  @domflax/patterns  (flatten/flex-center-wrapper)   │
│  @domflax/frontend-html (parse5)  │  @domflax/pattern-kit (definePattern + combinators  │
│  (frontend + backend co-located)  │   incl. RELATIONAL + RewriteFactory — DATA only)    │
├──────────────────────────────────┴────────────────────────────────────────────────────┤
│  L2  STYLE RESOLVER LAYER          @domflax/resolver-tailwind · @domflax/resolver-css   │
│      forward resolve(classes)→StyleMap · reverse emit(StyleMap)→shortest classes        │
│      selectorUsage() (compress safety) · reverse index + bounded set-cover + .df-x      │
├─────────────────────────────────────────────────────────────────────────────────────┤
│  L1  CORE BACKBONE  (pkg: @domflax/core)   IR · StyleMap + normalizer + inherited table │
│      · contracts · RewriteOp + applier · pass manager · diagnostics · EditEngine        │
│      ZERO @domflax deps. ZERO host deps (no glob/worker/PW).                             │
└─────────────────────────────────────────────────────────────────────────────────────┘
                 Dependency rule: arrows point DOWN only. Core depends on nothing.
```

---

## 3. L1 — `@domflax/core`: IR backbone & shared contracts

The authoritative public types are in `packages/core/src/types.ts` (the `coreContract` artifact).
Highlights and the changes the reviews forced:

### 3.1 Identity (D1: branded **numbers**)
`IRNodeId`/`SourceFileId`/`ExprRef = Brand<number,…>`; `IdAllocator.next()`.

### 3.2 Source spans
Canonical UTF-16 code-unit offsets (`magic-string`/Babel convention). Frontends convert native
offsets to UTF-16 units (parse5 code-points → units); an emoji/CJK conformance fixture gates this.

### 3.3 `StyleMap` (D2: condition-keyed blocks + per-decl provenance)

`StyleMap = { blocks: Map<ConditionKey, StyleBlock> }`, each block keyed by a `StyleCondition`
(`media`, sorted `states`, `pseudoElement`). `StyleDecl` is canonical longhand and now carries two
review-driven flags:

- **`relativeToParent`** — set when the value uses a parent-relative unit (`em/ex/ch/%/lh`,
  font-relative `line-height`). The applier **refuses** to `foldInheritedStyles` such a decl onto a
  child whose reference differs (review-1 major: relative-unit fold), emitting
  `DF_RELATIVE_UNIT_FOLD`.
- **`inherited`** — whether the property is in the canonical inherited-property table.

**Inherited-property table (review-1 major).** A versioned `InheritedPropertyTable` lives in core
as the single source consumed by `foldInheritedStyles`, `hasOwnVisualStyle` reasoning, and the
verifier. It pins the full ~30+ inherited set (`direction`, `writing-mode`, `text-orientation`,
`text-align`, `text-indent`, `text-transform`, `white-space`, `word-break`, `overflow-wrap`,
`tab-size`, `letter/word-spacing`, `line-height`, `visibility`, **`cursor`**, **`user-select`**,
**`caret-color`**, **`accent-color`**, `list-style-*`, `quotes`, `caption-side`, `border-collapse`,
`empty-cells`, `color-scheme`, `hyphens`, `-webkit-text-*`, plus all `--*` custom properties) with a
conformance fixture. `isInherited()` returns true for any `--*`. `foldInheritedStyles(…,'all-inherited')`
binds to this table and **fails loudly** on an unknown inheritable property rather than dropping it.

**Normalizer boundary** unchanged: the shared normalizer does *syntactic* canonicalization only
(shorthand expansion, color/unit, ordering) — it never resolves `initial/inherited/computed`. That
remains the verifier's `toComputedComparable` job.

### 3.4 IR nodes (D3 union: `element | text | expr | fragment | comment`)

`NodeMeta` gains the box/formatting/paint/structural facts the reviews proved are load-bearing:

- **`targetedByStructuralPseudo`** (review-1 blocker): node matched by
  `:first/last/only/nth-child/of-type`.
- **`establishesStackingContext`** + **`isContainingBlock`** + **`establishesFormattingContext`**
  (review-1/4 blocker): `position!=static(+z)`, `transform`, `filter`, `opacity<1`, `will-change`,
  `isolation`, `mix-blend-mode`, `contain`, `perspective`, `clip-path/mask`.
- **`declaresCustomProperties`** (review-1 major): element sets any `--*` a descendant reads.
- `hasOwnVisualStyle` is now defined **across ALL StyleConditions** (states + media +
  pseudo-elements), not BASE_CONDITION only (review-1/4 major).

`IRExpr` (not a node kind for "opaque") models dynamic JS; element opacity is `NodeMeta` booleans.

### 3.5 Author tokens
`ClassList`/`AttrMap`/`InlineStyle` segmented model unchanged (static tokens optimizable; dynamic
segments are verbatim barriers spliced around).

### 3.6 One document
`IRDocument` (D9): flat `Map<IRNodeId,IRNode>` + `ExprRegistry` + `BackrefTable` (whole/open/close/
inner spans) + `IdAllocator`. Serializable, acyclic. `walk()` is mutation-safe (snapshots child ids).

---

## 4. L2 — Style Resolver layer

`StyleResolver` (`resolve` forward / `emit` reverse) with the three-way `resolved/unknown/opaque`
partition unchanged. Reverse-emit stays a weighted **subset-only** set-cover (`isSubset` gate;
residual → content-hashed synthetic `.df-x`). Review-driven additions:

- **`OpaqueReason`** expanded: split `css-var-coupling` into `tw-var-coupling` and
  **`author-var-coupling`** (review-1 major — author `--*` read across a wrapper blocks flatten,
  or the decl must be folded), plus **`structural-pseudo`**, **`compound-membership`**, and
  `descendant-selector`.
- **`selectorUsage(token) → SelectorUsage`** (review-1 major, compress safety). Before drop/rename,
  resolver-css reports *every* selector referencing a class — as subject, ancestor, compound
  qualifier, sibling, or `:has()` argument. A class is `droppable` only if used **solely** as a
  plain subject; any non-trivial membership is preserved verbatim (treated opaque for compression).
  The verifier additionally diffs **descendant** leaves, where these regressions surface.

---

## 5. L3 — Pattern-Kit & the pattern library

### 5.1 `Pattern` contract (D4: single pure `evaluate`)

`evaluate(ctx: MatchContext, rw: RewriteFactory): MatchResult | null`. `MatchContext.node` and
`.doc` are typed **`DeepReadonly<…>`** so a pattern *cannot* mutate the IR (review-2 blocker turned
into a compile-time guarantee; dev additionally wraps them in a throw-on-write Proxy). This is also
what makes intra-document parallel evaluation safe.

`MatchContext` now exposes **relational read accessors** (review-2 major): `ancestors()`,
`closest(pred)`, `prevSibling()`, `nextSibling()`, `nthChildIndex()`, alongside the node-local
`parent()/elementChildren()/onlyElementChild()/computed()/isOpaque()`.

### 5.2 `RewriteOp` union (closed; constructed as origin-free **drafts**)

The factory emits `RewriteOpDraft` (the union minus `origin`); the scheduler stamps `origin` from
the emitting pattern, so provenance is trustworthy, not author-forgeable. The op set is no longer
flatten-biased (review-2 major) — added **structural ops** with explicit magic-string lowerings:
`wrap`, `insertBefore`, `insertAfter`, `moveNode`, `mergeSiblings` (move = delete-span + insert via
Backref spans, staying on the surgical-edit path instead of degrading to reprint).

`replaceWith`/`wrap`/`insert*` take a **`NodeSpec`** — a detached, id-free node description the pure
factory builds via `rw.element()/rw.text()/rw.keep()` *without* touching `doc.alloc`/`doc.nodes`
(review-2 major: synthesis was previously impossible inside a pure `evaluate`). The applier
materializes ids during apply. `rw.keep(node)` reuses an existing node, preserving its `IRNodeId`
(D10).

`foldInheritedStyles` now carries `conditions: 'base' | 'all'` (default `'all'`) so it folds
inheritable decls across **every** `StyleCondition`, not just BASE_CONDITION (review-1/4 major).

### 5.3 DSL combinators (`@domflax/pattern-kit`)

Adds **relational combinators** backed by the new `MatchContext` accessors (review-2 major):
`ancestor`/`closest`, `parentMatches`, `prevSibling`/`nextSibling`, `everyChild`/`someChild`,
`nthChild`. New safety guards: `establishesStackingContext()`, `isContainingBlock()`,
`targetedByStructuralPseudo()`, `affectsSiblingSelectors()`, `declaresCustomProps()`,
`whitespaceSensitive()`. `establishesBox()` is **hardened** to also return true for any
stacking-context / containing-block / formatting-context trigger (review-1/4 blocker). pattern-kit
holds no IR mutator — op **data** only.

A capture-establishing matcher (`hasSingleElementChild`) threads a typed non-null capture into the
`rewrite` context, removing the fragile `!` (review-2 minor).

### 5.4 The hardened Stage-1 pattern

`flatten/flex-center-wrapper` is corrected for the flex-item blockification hole (review-1 blocker):
the rationale "no explicit box ⇒ flex shrinks to content ⇒ centering is a no-op" is **insufficient**
because a flex container blockifies and re-sizes its children. The final `when` requires:

```
when: and(
  isElement(),
  centersChildren('both'),              // inspects ALL StyleConditions
  not(establishesBox()),                // now incl. stacking/containing/formatting context
  not(establishesStackingContext()),
  not(isContainingBlock()),
  not(hasOwnVisualStyle()),             // across states + pseudo-elements (:hover/::before)
  not(declaresCustomProps()),           // author --* coupling
  not(whitespaceSensitive()),
  not(targetedByStructuralPseudo()),
  hasSingleElementChild(childIsDomElement()),   // FORBID component child (review-4 blocker)
  childBoxParityWithFlow(),             // child's box-type/size survives wrapper removal (review-1 blocker)
  parentInNormalBlockFlow(),            // no flex/grid stretch / fixed / %-base ancestor (review-4 blocker)
  isSafeToUnwrap(),                     // not(ref|handlers|key|non-static-class|combinator)
  not(affectsSiblingSelectors()),       // checks CHILD + former siblings, not the wrapper (review-1 blocker)
)
```

`isSafeToUnwrap` and the new structural guards consult `SelectorIndex.reparentImpact(node)` — the
set of nodes whose combinator/structural-pseudo match-set changes on unwrap (self, child, former
siblings) — so the guard is on the **right nodes**, not just the wrapper (review-1 blocker). The doc
`before/after` example is replaced with one that is genuinely invariant (block child in block-flow
parent with width parity) and annotated that any residual relies on verifier revert.

---

## 6. L5 — Pipeline, Pass Manager & the Applier

`runPipeline` (pure, no I/O): `Frontend.parse → PassManager.run (fixpoint) → Backend.print`. Phases
run `[flatten(fixpoint, max 12), compress(1), extract(2)]`. Determinism mandatory; an
`IterationSignature` (origin-free hash of applied op identities) halts with `DF_FIXPOINT_OSCILLATION`.

The **applier** (D6) is the one trusted mutator: mutates the flat Map **in place, transactionally,
per group**, with an **inverse journal** for CI-guard revert (immutable structural sharing rejected —
see §15). `validateGroup` runs all preconditions first (existence, `safety ≤ ceiling`, no static/
dynamic boundary crossing, inheritable-prop check, **relative-unit-fold rejection**, **custom-prop
coupling**, **reparent-impact emptiness**, resolvable `mergeStyle` conflict); failures drop the group
to `skipped[]` with a diagnostic and leave the tree untouched. `unwrap`/`foldInheritedStyles`
**preserve the child's `IRNodeId`** (D10) — the anchor the verifier's `data-df-leaf` relies on.

Diagnostics are a **string-literal union** `DiagnosticCode` (D7; no `const enum`); the runtime frozen
`as const` object lives in `constants.ts` annotated `/* @__PURE__ */`. New codes:
`DF_RELATIVE_UNIT_FOLD`, `DF_CUSTOM_PROP_COUPLING`, `DF_STRUCTURAL_PSEUDO_TARGET`,
`DF_SELECTOR_MEMBERSHIP`, `DF_VERIFY_INCONCLUSIVE`.

---

## 7. L4 — Frontends & Backends

Parse is lossless-by-reference (verbatim `SourceFile.text` + `Backref` spans). Codegen is
op-lowering to `TextEdit[]` via `magic-string`; `EditEngine` detects overlaps (`EditConflictError` →
skip later op), orders edits parent-before-child, and `assertNoOpaqueCrossing` forbids any edit
crossing a dynamic/ref/event/spread span. The new structural ops (`wrap`/`insert*`/`moveNode`/
`mergeSiblings`) have dedicated magic-string lowerings; recast is invoked **only** for `replaceWith`
of a spanless synthesized node. The Babel plugin passes `babelAst` so the JSX frontend skips
re-parse. parse5 auto-corrected subtrees are marked `hasDangerousHtml` and refused.

---

## 8. L6 — `@domflax/verify`: the equivalence verifier

Proves `before == after` despite structural divergence. Renders both sides headless (pinned browser
revision + bundled font). The reviews forced several soundness corrections:

1. **Real ancestor context, not fragment mode** (review-4 blocker). flex-center safety is non-local
   (parent stretch / fixed-height ancestor / percentage child). Verification mounts the actual
   parent chain (full route/page) so layout free-space, stretch, and percentage bases are real.
   Until full-route harnessing exists, Stage-1 is *restricted* to the `parentInNormalBlockFlow()`
   subset proven safe statically.

2. **Verdict is a boolean, not a "union"** (review-4 major). **Fail iff** `bbox-delta > tol` **OR**
   `allowlisted-style-delta`. The **pixel** pass is *advisory only*: a large pixel delta with passing
   bbox+style yields **`inconclusive`** (investigate), never `fail`; a small delta is ignored.

3. **Relational regressions get a dedicated pass** (review-4 blocker). Per-leaf bbox+style is blind
   to stacking order and containing-block reparenting. A **paint-order/stacking check** (sampled
   `elementsFromPoint` / paint-order hash) is added; the hardened `establishesBox()`/
   `establishesStackingContext()`/`isContainingBlock()` guards block these statically as the primary
   defense — the verifier is the backstop, never the sole guard.

4. **Deterministic `data-df-leaf` anchoring** (review-4 major). IDs are driven from the **single
   pipeline run's journal** (which child ids survived `unwrap`/`fold`) and injected into BOTH the
   original-render harness and the emitted output — not from a second independent parse (allocator
   ids are not stable across parses). The verifier asserts 1:1 df-leaf coverage of all visual leaves;
   any leaf without a unique anchor ⇒ **`inconclusive`**, never a signature-collision fallback.

5. **Multi-state / multi-pseudo rendering** (review-1/4 major). The verifier enumerates and *drives*
   the states/pseudo-classes actually present in the subtree's StyleMap (`:hover`, `:focus`,
   `:focus-within`, `:active`) and each media breakpoint, capturing each — not just the default
   state. `hasOwnVisualStyle()`/`centersChildren()` already inspect all conditions (§3.4).

6. **Closed allowlist with a fail-safe catch-all** (review-4 minor). The visual-property allowlist is
   published and version-pinned (incl. inherited interaction props: `cursor`, `user-select`,
   `caret-color`, `accent-color`; plus `background-clip`, `-webkit-text-fill-color`). If
   `getComputedStyle` exposes *any* off-allowlist property differing between sides ⇒ **`inconclusive`**,
   so omissions fail safe.

7. **Determinism contract for async resources** (review-4 minor): `await document.fonts.ready` (force
   app webfonts, not just the bundled one), eager image loading, synchronous-fire stubs for
   Intersection/ResizeObserver, `content-visibility:visible`, frozen time/random/animation.

8. **`fuzz-prove` covers relational + parent contexts** (review-2/4 blocker). `PreconditionSketch` is
   now relational (`ancestor`/`siblings`/`childShapes` tree shapes) **and** declares
   `parentContexts: ParentLayoutContext[]` (`block-flow`, `flex-item-stretch`, `grid-item`,
   `fixed-size-ancestor`, `percentage-sized-child`, `inline-context`). The generator enumerates each;
   at fuzz time it **asserts every generated tree matches `when`** and reports match-space coverage,
   so an under-specified sketch fails loudly instead of proving a trivial subset. Stage-1 exit is
   contingent on parent-context coverage, not node-local fuzzing alone.

**Component children are forbidden** in the Stage-1 pattern (review-4 blocker): folding inherited
styles onto `<Foo/>` that may not forward className/style silently loses them, and component render
needs a per-file `PropsFixture` that doesn't scale. The single child must be a real DOM element.

**Three verdicts**: anything unmountable/nondeterministic/ambiguous is **`inconclusive`** and blocks
the optimization. The "never a false pass" guarantee is **scoped** (review-4 minor): *no false pass
within {tested viewports, tested states, allowlisted properties, uniquely-anchored leaves}*; residual
unsound dimensions (untested states, off-allowlist properties, ambiguous leaves) are explicitly
listed for consumers.

**Inheritance assumes IR tree == rendered DOM tree** (review-1 minor): runtime DOM relocation
(`createPortal`, framework-hoisted fragments) is out of scope for static fold reasoning and is caught
only by the real-DOM verifier; `hasDynamicChildren` opacity is the primary guard.

---

## 9. L7/L8 — Orchestrator, adapters & tooling

Orchestrator (D8) lives in the `domflax` meta package (core stays host-dependency-free, exposing pure
`runPipeline`). `transform()` never throws — it degrades to original + report. Cache key =
`sha256(normSource ⊕ configHash ⊕ patternSetVersion ⊕ resolverFingerprint ⊕ toolchainVersion)` with
negative caching. Workers receive data only and rebuild a `ResolvedConfig` from `configModulePath`;
closure/AST-only configs force `parallel:'off'`. `verify` defaults `'off'` in dev, `'ci-guard'` in
build/CI.

---

## 10. Package map

| Package | Layer | Contents | Depends on |
|---|---|---|---|
| `@domflax/core` | L1/L5 | IR + flat store, `StyleMap` + normalizer + **InheritedPropertyTable** + reverse-index/set-cover/synthetic types, contracts, `RewriteOp` + applier, pass manager, `runPipeline`, `EditEngine`, diagnostics, config **types** | none |
| `@domflax/pattern-kit` | L3 | `definePattern`, node-local + **relational** combinators, `V`, `RewriteFactory` (op data + pure node builders) | core |
| `@domflax/patterns` | L3 | Rule library. Stage 1 = hardened `flatten/flex-center-wrapper` | core, pattern-kit |
| `@domflax/resolver-tailwind` | L2 | forward via user engine; reverse index; `selectorUsage` | core; peer `tailwindcss`, `lightningcss` |
| `@domflax/resolver-css` | L2 | cascade-faithful; full `selectorUsage`/opaque classification | core; `lightningcss`, `postcss-selector-parser` |
| `@domflax/frontend-jsx` | L4 | JSX frontend **+ backend** | core; `@babel/*`, `magic-string` |
| `@domflax/frontend-html` | L4 | HTML frontend **+ backend** | core; `parse5`, `entities`, `magic-string` |
| `@domflax/verify` | L6 | ancestor-context render, boolean verdict, paint-order check, fuzz-prove, ci-guard | core, pattern-kit; `playwright`, `pixelmatch`, `pngjs`, `colorjs.io` |
| `@domflax/cli` | L8 | `runCli`, auto-detect | domflax; `fast-glob` |
| `domflax` (meta) | L7/L8 | Orchestrator + unplugin adapters (+ heavy deps `external` + lazy `import()`) | core, pattern-kit, patterns, resolver-*, frontend-*, verify (lazy); `unplugin`, `piscina` |

---

## 11. Build & packaging (review-3 — fully rewired)

The current single-package skeleton is replaced by a real workspace before any build claim holds:

- **Workspaces** (review-3 blocker): root `package.json` `{ "private": true, "workspaces":
  ["packages/*"] }`. The publishable meta package moves to `packages/domflax` (the workspace root is
  no longer the published `domflax`). Each package has its own tsconfig (`composite: true`,
  `declaration: true`, `rootDir: src`, `references` to internal deps); a root `tsconfig.base.json`
  holds shared options; a root solution tsconfig references all packages for `tsc -b`.
- **Declarations via `tsc -b`, JS via tsup** (review-3 blocker). tsup `dts` and `tsc -b` project
  references are mutually incompatible (rollup-plugin-dts inlines source types and breaks
  `isolatedDeclarations`). Decision: `.d.ts` emitted by `tsc -b` (composite, paths → built `dist`,
  so siblings appear as external `import('@domflax/core')`); tsup runs with `dts: false` for JS only.
- **Per-condition exports types** (review-3 major): `{ "import": { "types": "./dist/index.d.ts",
  "default": "./dist/index.js" }, "require": { "types": "./dist/index.d.cts", "default":
  "./dist/index.cjs" } }`. `arethetypeswrong` + `publint` gate every package in CI.
- **Tree-shaking** (review-3 major): every package declares `"sideEffects": false`; the frozen
  `SAFETY`/`DiagnosticCode` runtime objects are annotated `/* @__PURE__ */ Object.freeze(...)`. A
  fixture bundle asserts importing only the Vite adapter pulls **zero** playwright/babel bytes.
- **Adapter isolation** (review-3 major): heavy/optional deps are `external` in each tsup config and
  gated behind dynamic `import()`; a bundle-size assertion guards the adapter entrypoint. *Rejected*:
  splitting the orchestrator into a new package (the brief fixes the 11-package list) — instead the
  isolation is enforced via externals + lazy import + the size assertion.
- **`moduleResolution: NodeNext`** for the typecheck/declaration build (review-3 major) so TS
  validates the exports map the way Node will; tsup/esbuild still emit.
- **TS6 flags on from day one** (review-3 minor): `isolatedDeclarations: true`, `erasableSyntaxOnly:
  true` in the base config (the contract is already compatible — verified).
- **Sourcemaps** (review-3 minor): publish with inlined `sourcesContent` (or `sourcemap:false`); do
  not ship dangling maps. Drop the redundant `.npmignore` in favor of `files: ["dist"]` from a shared
  template. Enforce the DAG with `dependency-cruiser`/`eslint-plugin-import` no-cycle in CI; keep all
  core→{kit,resolver} references `import type`.

---

## 12. Three-stage rollout

- **Stage 1 — prove the spine.** ONE hardened pattern end-to-end with the *restricted* safe subset
  (block-flow parent, DOM-element child, content-driven size). core + pattern-kit +
  resolver-tailwind (forward+reverse+`selectorUsage`) + frontend-jsx + verify (ancestor-context,
  boolean verdict, paint-order, relational fuzz-prove) + Vite adapter (inline, no workers). Exit:
  flex-center fuzz-proven across all `parentContexts`; Vite build optimizes a real static-JSX app
  with ci-guard green. Component-heavy apps are out of trustworthy scope until Stage-2 fixtures.
- **Stage 2 — breadth.** resolver-css (cascade + full `selectorUsage`), frontend-html + cli, compress
  patterns (with selector-membership safety), CompositeResolver, worker pool, on-disk cache,
  multi-state/full-route verifier harness.
- **Stage 3 — scale.** `extract/@apply`, Bootstrap resolver, Next/webpack (+Turbopack), cross-file +
  remote cache, style variants materialized.

---

## 13. Key decisions

- **D1** Branded **numbers** for ids. **D2** Condition-keyed `StyleMap` + per-decl provenance.
- **D3** Union `element|text|expr|fragment|comment`; opacity via `NodeMeta`/`IRExpr`.
- **D4** Single pure `Pattern.evaluate`; `when/capture/rewrite` is kit sugar.
- **D5** Patterns emit op **data**; the applier lives in core.
- **D6** Applier mutates in place, transactionally, with an inverse journal (no immutable sharing).
- **D7** No `const enum`; string/number-literal unions + `/* @__PURE__ */` frozen runtime objects.
- **D8** Orchestrator in `domflax`; core host-dependency-free.
- **D9** One `IRDocument` carrying the `BackrefTable`.
- **D10** `unwrap`/`fold` preserve child `IRNodeId` (verifier anchor).
- **D11 (new)** Patterns receive `DeepReadonly` IR — invariant #4 is compile-time-enforced.
- **D12 (new)** `RewriteFactory` emits origin-free **drafts** + builds detached `NodeSpec`s purely;
  the applier materializes ids. Structural ops (`wrap`/`insert*`/`moveNode`/`mergeSiblings`) are
  first-class with surgical lowerings.
- **D13 (new)** A single versioned `InheritedPropertyTable` is the source of truth for fold +
  inheritance reasoning; `foldInheritedStyles` is condition-aware and rejects relative-unit folds.
- **D14 (new)** Verifier verdict is boolean (bbox/style fail; pixel advisory→inconclusive), anchors
  from the single-run journal, renders real ancestor context + multi-state, and adds a paint-order
  check. `establishesBox` includes stacking/containing/formatting-context establishment.

---

## 14. Honest risks

Unchanged risks (normalizer completeness, Tailwind `--tw-*` coupling, layout-semantics-in-TS,
SelectorIndex completeness, pixel nondeterminism, repeated-leaf correspondence, fixpoint oscillation,
worker-config divergence, cache staleness, parse5 auto-correction, Babel ordering in Next,
id+Map indirection cost, Turbopack) plus the residual surfaced by review: the verifier's scoped (not
absolute) no-false-pass guarantee; relational regressions still depend on static guard completeness
for stacking/containing-block since per-leaf passes are blind to them; the inherited-property table
and selector-membership analysis are now *additional* load-bearing tables that must stay version-
pinned with conformance fixtures.

---

## 15. Review reconciliation (accept/reject)

**Review-1 (CSS correctness)** — all blockers/majors ACCEPTED: flex-item blockification (harden
pattern + fix doc example, §5.4); structural-pseudo guard (`targetedByStructuralPseudo` +
`structural-pseudo` opaque reason); combinator guard on right node (`reparentImpact`, child+siblings);
condition-aware fold + all-condition `hasOwnVisualStyle`; relative-unit fold rejection; stacking/
containing-block establishment; author custom-property coupling; inherited-property table; compress
selector-membership (`selectorUsage`); whitespace guard. Minors accepted (interaction props in
allowlist+fold table; portal/DOM-vs-tree documented). Nothing rejected.

**Review-2 (authoring)** — blocker (relational fuzz precondition) + majors ACCEPTED: relational
combinators; structural ops; pure `NodeSpec` builder; `DeepReadonly` purity enforcement. Minors
accepted (precondition↔when coverage assertion; typed captures; sibling-selector guard). Nothing
rejected.

**Review-3 (build)** — all ACCEPTED: workspaces stand-up; `tsc -b` dts + tsup JS-only; per-condition
exports types; `sideEffects:false` + `/* @__PURE__ */`; NodeNext for typecheck; TS6 flags on;
sourcemaps/npmignore cleanup; dep-cruiser. **One sub-suggestion REJECTED**: splitting the
orchestrator into a separate package — the brief fixes the package list; isolation is instead
enforced via `external` + lazy `import()` + a bundle-size assertion.

**Review-4 (verifier)** — all blockers/majors ACCEPTED: ancestor-context render; boolean verdict +
pixel advisory; paint-order/stacking check + hardened `establishesBox`; journal-driven `data-df-leaf`
anchoring; multi-state rendering + all-condition guards; forbid component children; ancestor-aware
fuzz coverage. Minors accepted (allowlist catch-all→inconclusive; async-resource determinism; scoped
no-false-pass guarantee). Nothing rejected.

**Standing rejection (carried from reconciliation, re-affirmed):** subsystem-2's pure immutable
applier with structural sharing — rejected (D6) because sharing buys little on a flat Map and is
incompatible with serializable id-referenced nodes; reversibility comes from the inverse journal.

---

## 16. Post-design decisions (refinements after the initial design)

These were finalized in design discussion *after* §1–15 and supersede any conflicting detail above.

### 16.1 Distribution — monorepo for dev, ONE package published
Keep the `@domflax/*` workspace packages for development, but mark them all `"private": true` and
**bundle them into the public `domflax` package** at build time (tsup `noExternal: [/^@domflax\//]`).
Only `domflax` is published, self-contained. Entry points (subpath exports of the one package):
`.` (plugin + adapters), `./pattern-kit` (author patterns), `./verify` (standalone checker), and a
`domflax` **bin** (CLI). `playwright` is an **optional peer** used only by `domflax/verify`.

### 16.2 Public surface — one install, one import
Users run `npm i -D domflax` and `import domflax from 'domflax'`. Per-bundler adapters are
**properties** off that import (`domflax.vite()`, `domflax.webpack()`), NOT subpaths like
`domflax/react`. Advanced modules (`pattern-kit`, `verify`) are the only subpaths.

### 16.3 Component frameworks = SOURCE transform, never index.html
For React/Next/Vite/Remix, domflax transforms the `.jsx/.tsx` **source** via the bundler's per-file
`transform` hook (one stage before JSX→createElement). A React app ships an empty `index.html`, so
the shipped HTML is never the target. The `frontend-jsx` (Babel) path handles components;
`frontend-html` (parse5) handles real `.html` (plain HTML / Astro static). No hydration mismatch:
server+client compile the same flattened source. **Turbopack** support is pending (no arbitrary
webpack loaders yet).

### 16.4 Static-transform safety boundaries (opaque nodes)
domflax never executes code. `{expression}` holes, capitalized `<Component/>`s, and
`dangerouslySetInnerHTML`/`innerHTML` (flagged `hasRawHtml`) are **opaque** — preserved verbatim,
never flattened into. So `async`/Server Components/data fetching/Suspense are unaffected. Only plain
intrinsic elements with resolvable styles are flattened.

### 16.5 CSS selector safety (do not flatten load-bearing wrappers)
A wrapper is only flattenable if removing it provably does not change any selector's matched-element
set — guards against `div div h1`, `a > b`, `:nth-child`, `+`/`~`, `:first/last-child`, and
specificity/cascade shifts. Mechanism: index all complex selectors (`postcss-selector-parser`) and
diff each relevant selector's match set on before vs after IR (matcher à la `css-select`). Tailwind
utilities are combinator-free (near-zero risk); custom/global CSS is the real risk → the resolver
must surface the full selector list. Unknown/dynamic-class cases → conservative skip. Exposed to
pattern-kit as `not(affectsSelectorMatching())` on every flatten pattern; the verifier is the
backstop. Basic combinator guard = Stage 1; full match-set diff = Stage 2.

### 16.6 `.map()` list rendering
The row template inside `data.map((item,i) => <div key={i}>…</div>)` is just JSX in the IR, so
flatten/compress apply automatically → every rendered row is leaner. `.map`, `key`, and `{item.x}`
holes are preserved. New guard: `key` must transfer to the surviving element when flattening (else
skip). Plus React-native **constant-element hoisting** for the static parts. domflax will **not**
auto-convert React lists to template+cloneNode/blocks (breaks reconciliation; that is Million-style
owned-boundary territory, opt-in, never transparent). Stage 2.

### 16.7 template+cloneNode ("templatize") scope
Applies ONLY where the output owns the runtime DOM: plain HTML, Astro static, vanilla, web
components. **Impossible for React** — React never parses HTML (no parse cost to cache) and owns/
tracks every DOM node (can't accept a cloned `Element`). Separate `runtime/templatize` pass +
`@domflax/runtime`, capability-gated on the backend, **verifier-mandatory**, default OFF, Stage 3.

### 16.8 `domflax/runtime` — runtime optimizer for dynamic HTML
Tiny, browser-targeted, zero-heavy-dep entry for HTML unknown at build time (CMS, markdown, fetched
fragments): `optimizeHtml(html): string` (sync, content-hash cached, native `<template>` parser),
`setOptimizedHTML(el, html)`, `prepareTemplate(html)`. Conservative (no computed styles / no verifier
at runtime → class-pattern + structural-only rules). Optional `optimizeHtmlAsync` (Web Worker pool)
for large/bulk payloads only. **Not a sanitizer** (still use DOMPurify on untrusted input).

### 16.9 Parallelism
Per-file transform is a pure function → embarrassingly parallel. **CLI mode**: own worker pool sized
`availableParallelism() - 1` (tinypool/piscina). **Plugin mode**: the bundler already parallelizes →
do not spawn our own pool. Synthetic class names are **content-hashed** (`.df-${hash(styles)}`), never
a global counter, for deterministic parallel output. Cross-file optimizations use map-reduce
(parallel map → serial reduce → parallel apply).

### 16.10 CLI safety & UX
Source is **read-only by default**; output → `--out`/`./domflax-out`, or in place only inside
disposable build dirs. In-place source rewrite needs `--dangerously-overwrite-source` + a clean git
tree; `--dry-run` previews. A no-args run launches an interactive wizard (`@clack/prompts`,
arrow/multiselect), **TTY-gated** so it never hangs CI; flags remain the scriptable path. Wizard and
flags build the same options object.
