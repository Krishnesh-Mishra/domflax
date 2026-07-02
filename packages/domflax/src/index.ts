/**
 * domflax — public meta package.
 *
 * Re-exports the entire `@domflax/core` public API (types + reference runtime) and the built-in
 * `@domflax/patterns` library, then layers thin, framework-agnostic build adapters on top
 * (`vite()` / `webpack()`) plus a programmatic `createDomflax()` factory.
 *
 * Each adapter runs the SAME single-file engine as {@link createDomflax} (JSX/TSX + HTML frontends +
 * lazy Tailwind/CSS resolver → core pass manager → reverse-emit → surgical backend). The adapters are
 * structurally typed against their bundlers — they never hard-depend on `vite` or `webpack`.
 *
 * `.jsx`/`.tsx` route to `@domflax/frontend-jsx` (Babel); `.html`/`.htm` route to
 * `@domflax/frontend-html` (parse5). Both emit via SURGICAL span edits over the original source.
 */

import { createPipeline } from '@domflax/core';
import type {
  EncodedSourceMap,
  Pattern,
  Pipeline,
  SafetyLevel,
  StyleResolver,
} from '@domflax/core';
import { builtinPatterns } from '@domflax/patterns';
import { createTailwindResolver } from '@domflax/resolver-tailwind';
import { createCssResolver } from '@domflax/resolver-css';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { htmlKindOf, jsxKindOf, runHtmlPipeline, runJsxPipeline } from './pipeline-run';
import {
  addStats,
  emptyTotals,
  printCompilationSummary,
  renderSummary,
  resetTotals,
  zeroStats,
  type FileStatDelta,
  type Totals,
} from './summary';

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

const DEFAULT_INCLUDE: readonly string[] = ['.jsx', '.tsx', '.html', '.htm'];

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
  /**
   * Per-file optimization delta (nodes removed / classes saved / bytes saved). Zeroed for
   * unsupported or unchanged files. Consumed by the build adapters to accumulate the build-end
   * {@link renderSummary summary}.
   */
  readonly stats: FileStatDelta;
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
   * Transform one file (SYNCHRONOUS, fully static, never launches a browser). For `.jsx`/`.tsx` this
   * runs the full pipeline (parse → resolve → flatten[provably-safe only] → reverse-emit → print);
   * every other (or unsupported) file is returned unchanged. Only provably layout-neutral flattens are
   * applied — domflax never changes rendering.
   */
  transform(code: string, id: string): DomflaxTransformResult;
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
      if (!isSupported(id, resolved.include)) return { code, map: null, stats: zeroStats() };
      const kind = jsxKindOf(id);
      if (kind !== null) {
        const out = runJsxPipeline(code, id, kind, getResolver(), patterns, resolved.safety);
        return { code: out.code, map: null, stats: out.stats };
      }
      // `.html`/`.htm` route to the parse5 HTML frontend/backend (surgical span edits).
      if (htmlKindOf(id) !== null) {
        const out = runHtmlPipeline(code, id, getResolver(), patterns, resolved.safety);
        return { code: out.code, map: null, stats: out.stats };
      }
      return { code, map: null, stats: zeroStats() };
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Build adapters (framework-agnostic, structurally-typed shapes)
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Minimal Vite-plugin shape. Declared locally so this adapter does NOT depend on `vite`'s types
 * (an optional, type-only peer). Structurally compatible with Vite's `Plugin` for the hooks domflax
 * uses: `enforce: 'pre'` runs domflax before Vite's JSX→`createElement` transform, and `transform`
 * is Vite's per-file source hook. Returning `null` is Vite's "no change" signal.
 */
export interface DomflaxVitePlugin {
  readonly name: string;
  readonly enforce: 'pre';
  /** Vite's per-file source hook. Fully synchronous and browser-free. */
  transform(code: string, id: string): DomflaxTransformResult | null;
  /** Vite build-start hook — resets the per-build summary accumulator (watch/serve safe). */
  buildStart(): void;
  /** Vite build-end hook — prints the aggregate {@link renderSummary} once (if anything changed). */
  buildEnd(): void;
  /** Vite close-bundle hook — prints the summary as a backstop if `buildEnd` did not fire. */
  closeBundle(): void;
}

/**
 * Vite adapter. Returns a real Vite `Plugin` (`enforce: 'pre'`) whose `transform` runs the domflax
 * engine on `.jsx`/`.tsx` modules — strips any bundler query suffix (e.g. `App.tsx?used`) before
 * matching, returns `{ code, map }` when the source changed, and `null` (Vite's unchanged signal)
 * for unchanged sources and for any non-jsx/tsx module.
 *
 * @example
 * ```js
 * // vite.config.js
 * import domflax from 'domflax';
 * export default { plugins: [domflax.vite({ provider: 'tailwind' })] };
 * ```
 */
export function vite(options: DomflaxOptions = {}): DomflaxVitePlugin {
  const engine = createDomflax(options);

  // Aggregate across every `transform` call in this plugin instance. `buildStart` resets it so
  // watch/serve rebuilds each get their own summary; a `printed` latch guards the double-fire of
  // `buildEnd` + `closeBundle`.
  const totals: Totals = emptyTotals();
  let printed = false;

  const printSummary = (): void => {
    if (printed) return;
    printed = true;
    if (totals.files > 0) process.stdout.write(renderSummary(totals));
  };

  return {
    name: 'domflax',
    enforce: 'pre',
    buildStart(): void {
      resetTotals(totals);
      printed = false;
    },
    transform(code: string, id: string): DomflaxTransformResult | null {
      if (!isSupported(id, engine.options.include)) return null;
      const out = engine.transform(code, id);
      const changed = out.code !== code;
      addStats(totals, out.stats, changed);
      // Signal "no change" to Vite when the source round-tripped unchanged.
      return changed ? out : null;
    },
    buildEnd(): void {
      printSummary();
    },
    closeBundle(): void {
      printSummary();
    },
  };
}

/* ── webpack / Next.js ──────────────────────────────────────────────────────────────────────── */

/** A `module.rule` `use` entry: an absolute loader path plus the options forwarded to it. */
interface DomflaxRuleUse {
  readonly loader: string;
  readonly options: DomflaxOptions;
}

/** The slice of a webpack `module.rule` domflax appends. */
interface DomflaxModuleRule {
  readonly test: RegExp;
  readonly enforce: 'pre';
  readonly exclude: RegExp;
  readonly use: readonly DomflaxRuleUse[];
}

/** Anything carrying a `module.rules` array — both a webpack `Compiler.options` and Next's bare config. */
interface DomflaxWebpackModuleHost {
  module?: { rules?: unknown[] };
  /** webpack's plugin list (present on both a real `Compiler.options` and Next's bare config). */
  plugins?: unknown[];
}

/** A tappable webpack hook (only the `tap` arm domflax uses). */
interface DomflaxWebpackHook {
  tap(name: string, fn: (arg: unknown) => void): void;
}

/**
 * Minimal webpack-compiler shape. Declared locally so this adapter does NOT depend on `webpack`'s
 * types. domflax only needs to push a rule onto the host's `module.rules`.
 *
 * `apply` accepts BOTH shapes: a real webpack `Compiler` (rules live under `compiler.options.module`)
 * AND the bare `config` object Next.js hands you from `webpack(config)` (rules live directly under
 * `config.module`). It duck-types `compiler.options ?? compiler` to find the right host.
 */
export interface DomflaxWebpackCompiler extends DomflaxWebpackModuleHost {
  options?: DomflaxWebpackModuleHost;
  /** Present only on a REAL webpack `Compiler` (not on Next's bare config). Used for the summary. */
  hooks?: { done?: DomflaxWebpackHook };
}

/**
 * Minimal webpack-plugin shape. `apply(compiler)` is the webpack plugin entry point.
 */
export interface DomflaxWebpackPlugin {
  readonly name: string;
  apply(compiler: DomflaxWebpackCompiler): void;
}

/** `.jsx`/`.tsx` modules only (combinator-free with the JSX frontend; `.js`/`.ts` are skipped). */
const WEBPACK_JSX_TEST = /\.[jt]sx$/;

/**
 * Absolute path to the bundled webpack loader (`./webpack-loader`). Resolved lazily against THIS
 * module's location so it works whether `domflax` is loaded as ESM (`dist/index.js`) or CJS
 * (`dist/index.cjs`) — both sit beside `dist/webpack-loader.cjs`. webpack requires loaders via
 * CommonJS, so we always point at the `.cjs` output.
 */
function webpackLoaderPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, 'webpack-loader.cjs');
}

/**
 * webpack adapter (also the Next.js path). Returns a plugin whose `apply(compiler)` injects a
 * pre-enforced `module.rule` that invokes the domflax {@link ./webpack-loader loader} on every
 * `.jsx`/`.tsx` module. The loader runs the SAME lazy engine as {@link createDomflax} (no eager
 * Tailwind/postcss load).
 *
 * Next.js wiring (`next.config.js`) — Next exposes the underlying webpack config via `webpack(config)`:
 * ```js
 * // next.config.js
 * const domflax = require('domflax');
 * module.exports = {
 *   webpack(config) {
 *     domflax.webpack({ provider: 'tailwind' }).apply(config);
 *     return config;
 *   },
 * };
 * ```
 * `apply(compiler)` is intentionally duck-typed on `compiler.options.module.rules`, so it accepts
 * both a real webpack `Compiler` and the bare `config` object Next.js hands you.
 *
 * Caveat: this targets the webpack builder only. **Turbopack is not yet supported** — it does not
 * accept arbitrary webpack loaders, so the `next.config.js` wiring above is a no-op under
 * `next dev --turbopack`. Run domflax through the webpack builder until Turbopack exposes a loader API.
 */
/**
 * Tap a REAL webpack `Compiler`'s `done` hook to print the build-end summary. The per-file stats were
 * stashed on the `compilation` by the loader (separate bundle) under a shared `Symbol.for` key; here
 * we read + print them once. No-op if `compiler` has no `done` hook (e.g. a bare config or a stub).
 */
function tapWebpackSummary(compiler: DomflaxWebpackCompiler): void {
  const done = compiler.hooks?.done;
  if (typeof done?.tap !== 'function') return;
  done.tap('domflax', (stats: unknown) => {
    // `done` receives a `Stats` whose `.compilation` is the object the loader wrote to; some stubs
    // pass the compilation directly.
    const compilation = (stats as { compilation?: unknown } | null)?.compilation ?? stats;
    printCompilationSummary(compilation);
  });
}

/**
 * Wire the summary printer. On a real `Compiler` we tap `done` directly. On Next's bare config (no
 * `hooks`) we push a child plugin onto `config.plugins`; webpack later calls its `apply(compiler)`
 * with the real `Compiler`, at which point we tap `done`.
 */
function installWebpackSummary(compiler: DomflaxWebpackCompiler, host: DomflaxWebpackModuleHost): void {
  if (typeof compiler.hooks?.done?.tap === 'function') {
    tapWebpackSummary(compiler);
    return;
  }
  const plugins = (host.plugins ??= []);
  if (Array.isArray(plugins)) {
    plugins.push({ apply: (real: DomflaxWebpackCompiler) => tapWebpackSummary(real) });
  }
}

export function webpack(options: DomflaxOptions = {}): DomflaxWebpackPlugin {
  // Validate options eagerly (parity with the other adapters); the resolver stays lazy.
  createDomflax(options);
  return {
    name: 'domflax',
    apply(compiler: DomflaxWebpackCompiler): void {
      // Real webpack passes a `Compiler` (rules under `.options.module`); Next's `webpack(config)`
      // passes the bare config (rules under `.module`). Duck-type to the right host.
      const host: DomflaxWebpackModuleHost = compiler.options ?? compiler;
      const mod = (host.module ??= {});
      const rules = (mod.rules ??= []);
      const rule: DomflaxModuleRule = {
        test: WEBPACK_JSX_TEST,
        enforce: 'pre',
        exclude: /node_modules/,
        use: [{ loader: webpackLoaderPath(), options }],
      };
      rules.push(rule);
      // Print the aggregate summary at build end (loader ↔ plugin bridge over the compilation).
      installWebpackSummary(compiler, host);
    },
  };
}

/**
 * The default-export namespace. Exposes the build adapters and the programmatic factory as an OBJECT
 * so the documented `import domflax from 'domflax'; domflax.vite()` / `domflax.webpack()` works (and a
 * CommonJS `const domflax = require('domflax'); domflax.vite()` too). The named exports
 * (`createDomflax`, `vite`, `webpack`, …) remain available for direct import.
 */
export interface DomflaxDefault {
  createDomflax(options?: DomflaxOptions): Domflax;
  vite(options?: DomflaxOptions): DomflaxVitePlugin;
  webpack(options?: DomflaxOptions): DomflaxWebpackPlugin;
}

/** Default export: an object exposing `vite`, `webpack`, and the programmatic `createDomflax`. */
const domflax: DomflaxDefault = { createDomflax, vite, webpack };
export default domflax;
