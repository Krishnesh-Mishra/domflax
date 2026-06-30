/**
 * domflax — public meta package.
 *
 * Re-exports the entire `@domflax/core` public API (types + reference runtime) and the built-in
 * `@domflax/patterns` library, then layers thin, unplugin-style build adapters on top
 * (`vite()` / `webpack()`) plus a programmatic `createDomflax()` factory.
 *
 * Status: v0 (early scaffold). Matching the published 0.0.1 behaviour, every adapter wires a core
 * {@link Pipeline} configured with a passthrough resolver and **returns source unchanged** — an
 * honest passthrough while the parse → resolve → flatten → compress → emit pipeline is built out.
 *
 * Future deps (intentionally NOT imported yet — they land in a later stage):
 *   - `unplugin`            — the real cross-bundler adapter factory backing vite()/webpack().
 *   - `@domflax/frontend-*` — JSX/TSX + HTML frontends feeding the pipeline.
 *   - `@domflax/backend-*`  — surgical codegen backends.
 *   - `@domflax/resolver-*` — Tailwind / custom-CSS style resolvers.
 */

import {
  BASE_CONDITION,
  conditionKey,
  createNullSelectorIndex,
  createPipeline,
  createSyntheticSink,
  elementIds,
  emptyStyleMap,
  getElement,
  runPasses,
} from '@domflax/core';
import type {
  ApplyContext,
  ClassList,
  ClassSegment,
  ClassToken,
  ConditionKey,
  CssProperty,
  EmitContext,
  EncodedSourceMap,
  FileKind,
  IRDocument,
  Pass,
  PassCategory,
  PassPhase,
  Pattern,
  Pipeline,
  SafetyLevel,
  StyleBlock,
  StyleDecl,
  StyleMap,
  StyleNormalizer,
  StyleResolver,
} from '@domflax/core';
import { builtinPatterns } from '@domflax/patterns';
import { createJsxBackend, createJsxFrontend } from '@domflax/frontend-jsx';
import { normalizer } from '@domflax/pattern-kit';
import { createTailwindResolver } from '@domflax/resolver-tailwind';
import { createCssResolver } from '@domflax/resolver-css';

// ── Re-export the public surface ──────────────────────────────────────────────────────────────
export * from '@domflax/core';
export * from '@domflax/patterns';

/* ────────────────────────────────────────────────────────────────────────── *
 * Options
 * ────────────────────────────────────────────────────────────────────────── */

/** How class names resolve to computed styles. */
export type DomflaxProvider = 'auto' | 'tailwind' | 'custom';

/** Public adapter/factory options (mirrors the documented `domflax({...})` surface). */
export interface DomflaxOptions {
  /** Resolution strategy. Defaults to `'auto'`. */
  readonly provider?: DomflaxProvider;
  /** Stylesheets to parse when `provider` is `'custom'`. */
  readonly cssFiles?: readonly string[];
  /** Preview changes without rewriting source. */
  readonly dryRun?: boolean;
  /** Optimization aggressiveness handed to the pass manager (0 lint … 3 aggressive). */
  readonly safety?: SafetyLevel;
  /** File globs/extensions the adapters should consider. Defaults to jsx/tsx/html. */
  readonly include?: readonly string[];
}

/** Fully-resolved options with defaults applied. */
export interface ResolvedDomflaxOptions {
  readonly provider: DomflaxProvider;
  readonly cssFiles: readonly string[];
  readonly dryRun: boolean;
  readonly safety: SafetyLevel;
  readonly include: readonly string[];
}

const DEFAULT_INCLUDE: readonly string[] = ['.jsx', '.tsx', '.html'];

function resolveOptions(options: DomflaxOptions): ResolvedDomflaxOptions {
  return {
    provider: options.provider ?? 'auto',
    cssFiles: options.cssFiles ?? [],
    dryRun: options.dryRun ?? false,
    safety: options.safety ?? 2,
    include: options.include ?? DEFAULT_INCLUDE,
  };
}

/** True when `id` is a file domflax knows how to transform. */
function isSupported(id: string, include: readonly string[]): boolean {
  // Strip query suffixes bundlers append (e.g. `App.tsx?used`).
  const clean = id.split('?', 1)[0] ?? id;
  return include.some((ext) => clean.endsWith(ext));
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Programmatic instance
 * ────────────────────────────────────────────────────────────────────────── */

/** Result of a single-file transform. `map` is null until codegen lands. */
export interface DomflaxTransformResult {
  readonly code: string;
  readonly map: EncodedSourceMap | null;
}

/**
 * A configured domflax engine. Holds the wired core {@link Pipeline}, the passthrough
 * {@link StyleResolver}, and the built-in {@link Pattern} set, and exposes a single-file
 * `transform`.
 */
export interface Domflax {
  readonly options: ResolvedDomflaxOptions;
  readonly pipeline: Pipeline;
  readonly resolver: StyleResolver;
  readonly patterns: readonly Pattern[];
  /**
   * Transform one file. For `.jsx`/`.tsx` this runs the full pipeline (parse → resolve → flatten →
   * reverse-emit → print); every other (or unsupported) file is returned unchanged.
   */
  transform(code: string, id: string): DomflaxTransformResult;
}

/** `.tsx`/`.jsx` ⇒ the matching {@link FileKind}; anything else ⇒ null (no JSX frontend). */
function jsxKindOf(id: string): FileKind | null {
  const clean = id.split('?', 1)[0] ?? id;
  if (clean.endsWith('.tsx')) return 'tsx';
  if (clean.endsWith('.jsx')) return 'jsx';
  return null;
}

/** First registered source's EOL, defaulting to `\n`. */
function eolOf(doc: IRDocument): '\n' | '\r\n' {
  for (const src of doc.sources.values()) return src.eol;
  return '\n';
}

/** Group the flat pattern list into one {@link Pass} per {@link PassPhase} (derived from category). */
function buildPasses(patterns: readonly Pattern[]): Pass[] {
  const byPhase = new Map<PassPhase, Pattern[]>();
  for (const p of patterns) {
    const phase = (p.category.split('/', 1)[0] ?? 'flatten') as PassPhase;
    let bucket = byPhase.get(phase);
    if (!bucket) {
      bucket = [];
      byPhase.set(phase, bucket);
    }
    bucket.push(p);
  }
  const passes: Pass[] = [];
  for (const [phase, pats] of byPhase) {
    passes.push({ phase, category: `${phase}/builtin` as PassCategory, patterns: pats });
  }
  return passes;
}

/** The BASE-condition declaration map of a StyleMap (empty when absent). */
function baseDecls(sm: StyleMap): ReadonlyMap<CssProperty, StyleDecl> {
  return sm.blocks.get(conditionKey(BASE_CONDITION))?.decls ?? new Map<CssProperty, StyleDecl>();
}

/** The BASE-condition declarations present in `current` but not equal-valued in `original`. */
function residualStyleMap(current: StyleMap, original: StyleMap): StyleMap {
  const orig = baseDecls(original);
  const decls = new Map<CssProperty, StyleDecl>();
  for (const [prop, decl] of baseDecls(current)) {
    const had = orig.get(prop);
    if (!had || had.value !== decl.value) decls.set(prop, decl);
  }
  if (decls.size === 0) return emptyStyleMap();
  const block: StyleBlock = { condition: BASE_CONDITION, decls };
  return { blocks: new Map<ConditionKey, StyleBlock>([[conditionKey(BASE_CONDITION), block]]) };
}

/** All static class tokens of a ClassList, in order. */
function staticTokensOf(cl: ClassList): string[] {
  const out: string[] = [];
  for (const seg of cl.segments) {
    if (seg.kind === 'static') for (const t of seg.tokens) out.push(t.value);
  }
  return out;
}

/** A rewritable static {@link ClassList} over `tokens`, preserving the previous list's spans. */
function staticClassList(prev: ClassList, tokens: readonly string[]): ClassList {
  const classTokens: ClassToken[] = tokens.map((value) => ({ value }));
  const seg: ClassSegment = { kind: 'static', tokens: classTokens };
  return {
    form: 'string-literal',
    segments: [seg],
    valueSpan: prev.valueSpan,
    attrSpan: prev.attrSpan,
    hasDynamic: false,
    opaque: false,
    rewritable: true,
  };
}

/**
 * Reverse-emit step (computed → className). The backend re-prints `className` from each element's
 * {@link ClassList}, but the pass manager records optimized styles on `computed`. For every TOUCHED,
 * rewritable element this folds the *new* computed declarations (those not already produced by its
 * existing class tokens) back into class tokens via {@link StyleResolver.emit}, appending them while
 * keeping the element's original (still-meaningful) tokens.
 */
function syncClassesFromComputed(
  doc: IRDocument,
  resolver: StyleResolver,
  norm: StyleNormalizer,
): void {
  const sink = createSyntheticSink();
  for (const id of elementIds(doc)) {
    const el = getElement(doc, id);
    if (!el || !el.meta.touched) continue;
    if (el.classes.opaque || el.classes.hasDynamic) continue;

    const tokens = staticTokensOf(el.classes);
    const original = norm.normalizeStyleMap(
      resolver.resolve({
        classes: tokens,
        element: { tagName: el.tag, namespace: el.namespace === 'svg' ? 'svg' : 'html' },
      }).styles,
    );
    const residual = residualStyleMap(el.computed, original);
    if (baseDecls(residual).size === 0) continue;

    const ctx: EmitContext = { normalizer: norm, sink };
    const emitted = resolver.emit(residual, ctx).classes;
    if (emitted.length === 0) continue;

    const next = [...tokens];
    for (const c of emitted) if (!next.includes(c)) next.push(c);
    el.classes = staticClassList(el.classes, next);
  }
}

/** Run the full JSX/TSX pipeline and return the re-printed source. */
function runJsxPipeline(
  code: string,
  id: string,
  kind: FileKind,
  resolver: StyleResolver,
  patterns: readonly Pattern[],
  safety: SafetyLevel,
): string {
  // 1. PARSE — the frontend lowers JSX → IR and resolves each element's static classes through the
  //    injected resolver into `el.computed` (so the "resolve styles onto each element" step is done
  //    here, via createTailwindResolver().resolve(classTokens)).
  const parsed = createJsxFrontend().parse(code, {
    id,
    kind,
    resolver,
    normalizer,
    config: {},
    onDiagnostic: () => {},
  });
  const doc = parsed.doc;

  // 2. AUTHORIZE — the JSX frontend defaults every node's safety floor to 0 (no optimization). The
  //    orchestrator opens the floor to the max; the configured ceiling + each pattern's own opacity
  //    predicates are the real gate.
  for (const node of doc.nodes.values()) node.meta.safetyFloor = 3;

  // 3. PASSES — drive the built-in patterns to a fixpoint via the core pass manager.
  const ctx: ApplyContext = {
    doc,
    safetyCeiling: safety,
    normalizer,
    selectors: createNullSelectorIndex(),
    resolver,
  };
  const { doc: optimized } = runPasses(doc, buildPasses(patterns), ctx);

  // 4. REVERSE-EMIT — fold optimized computed styles back into class tokens for the backend.
  syncClassesFromComputed(optimized, resolver, normalizer);

  // 5. PRINT — IR → JSX/TSX text.
  const printed = createJsxBackend().print(
    optimized,
    { moduleId: id, ops: [], provenance: new Map() },
    {
      normalizer,
      resolver,
      sink: createSyntheticSink(),
      eol: eolOf(optimized),
      onDiagnostic: () => {},
    },
  );
  return printed.code;
}

/**
 * Build a configured domflax engine.
 *
 * Wires a real single-file pipeline: the JSX/TSX frontend + a Tailwind resolver feed the core pass
 * manager (running {@link builtinPatterns}), whose output is reverse-emitted back to class tokens
 * and re-printed by the JSX backend. Non-jsx/tsx files pass through unchanged.
 */
/**
 * Build the {@link StyleResolver} for the chosen provider. The heavy engine each resolver wraps
 * (Tailwind v3 / postcss) is loaded LAZILY — at the moment this factory runs — and resolved from the
 * CONSUMER'S project, NOT from domflax's (possibly bundled) location. Both engines are OPTIONAL peer
 * dependencies of the published `domflax`: a Tailwind-only user never triggers a postcss load, and a
 * custom-CSS-only user never triggers a Tailwind load, because only the selected branch constructs.
 */
function createResolver(resolved: ResolvedDomflaxOptions): StyleResolver {
  if (resolved.provider === 'custom') {
    return createCssResolver([], { files: resolved.cssFiles });
  }
  // 'auto' and 'tailwind' both resolve against the project's Tailwind engine.
  return createTailwindResolver();
}

export function createDomflax(options: DomflaxOptions = {}): Domflax {
  const resolved = resolveOptions(options);
  const pipeline = createPipeline();
  const patterns = builtinPatterns;

  // Construct the resolver lazily so neither optional engine (Tailwind / postcss) is loaded until a
  // file is actually transformed (and only the engine for the selected provider is ever loaded).
  let cachedResolver: StyleResolver | null = null;
  const getResolver = (): StyleResolver => (cachedResolver ??= createResolver(resolved));

  return {
    options: resolved,
    pipeline,
    get resolver(): StyleResolver {
      return getResolver();
    },
    patterns,
    transform(code: string, id: string): DomflaxTransformResult {
      if (!isSupported(id, resolved.include)) return { code, map: null };
      const kind = jsxKindOf(id);
      // Non-jsx/tsx supported files (e.g. .html) stay passthrough — no HTML frontend wired yet.
      if (kind === null) return { code, map: null };
      const out = runJsxPipeline(code, id, kind, getResolver(), patterns, resolved.safety);
      return { code: out, map: null };
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Build adapters (unplugin-style, framework-agnostic shapes)
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Minimal Vite-plugin shape. Declared locally so this stub does NOT depend on `vite` (a future
 * peer). Structurally compatible with Vite's `Plugin` for the hooks domflax uses.
 */
export interface DomflaxVitePlugin {
  readonly name: string;
  readonly enforce?: 'pre' | 'post';
  transform(code: string, id: string): DomflaxTransformResult | null;
}

/**
 * Vite adapter (stub). Returns a plugin whose `transform` is an honest passthrough: it yields
 * `null` (Vite's "unchanged" signal) for every module today.
 *
 * Future: this will be derived from `unplugin`'s `createVitePlugin`.
 */
export function vite(options: DomflaxOptions = {}): DomflaxVitePlugin {
  const engine = createDomflax(options);
  return {
    name: 'domflax',
    enforce: 'pre',
    transform(code: string, id: string): DomflaxTransformResult | null {
      if (!isSupported(id, engine.options.include)) return null;
      const out = engine.transform(code, id);
      // Signal "no change" to Vite while we passthrough.
      return out.code === code ? null : out;
    },
  };
}

/**
 * Minimal webpack-plugin shape. Declared locally so this stub does NOT depend on `webpack` (a
 * future peer). `apply(compiler)` is the webpack plugin entry point.
 */
export interface DomflaxWebpackPlugin {
  readonly name: string;
  apply(compiler: unknown): void;
}

/**
 * webpack adapter (stub). Returns a plugin object. Wiring a webpack loader/plugin around the core
 * pipeline lands in a later stage via `unplugin`'s `createWebpackPlugin`.
 *
 * For now `apply` is a no-op (honest passthrough — the build is left untouched).
 */
export function webpack(options: DomflaxOptions = {}): DomflaxWebpackPlugin {
  // Construct the engine so options validate identically across adapters.
  createDomflax(options);
  return {
    name: 'domflax',
    apply(_compiler: unknown): void {
      // Honest passthrough: no loaders/hooks registered yet.
      // Future: createDomflax(options) drives an unplugin webpack plugin here.
    },
  };
}

/** Default export: the programmatic factory. */
export default createDomflax;
