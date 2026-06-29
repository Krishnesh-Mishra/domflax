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

import { createNullResolver, createPipeline } from '@domflax/core';
import type {
  EncodedSourceMap,
  Pattern,
  Pipeline,
  SafetyLevel,
  StyleResolver,
} from '@domflax/core';
import { builtinPatterns } from '@domflax/patterns';

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
  /** Transform one file. Honest passthrough for now: returns `code` unchanged. */
  transform(code: string, id: string): DomflaxTransformResult;
}

/**
 * Build a configured domflax engine.
 *
 * Wires a core pipeline with a passthrough resolver and the built-in pattern set. The real
 * frontend/backend/normalizer wiring (and hence `pipeline.run`) lands in a later stage; until then
 * {@link Domflax.transform} is an honest passthrough returning the input unchanged.
 */
export function createDomflax(options: DomflaxOptions = {}): Domflax {
  const resolved = resolveOptions(options);
  const pipeline = createPipeline();
  const resolver = createNullResolver();
  const patterns = builtinPatterns;

  return {
    options: resolved,
    pipeline,
    resolver,
    patterns,
    transform(code: string, id: string): DomflaxTransformResult {
      if (!isSupported(id, resolved.include)) {
        return { code, map: null };
      }
      // Honest passthrough: matches published 0.0.1. Real wiring (frontend.parse → pipeline.run →
      // backend.print) lands once the frontend/backend/normalizer packages exist.
      return { code, map: null };
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
