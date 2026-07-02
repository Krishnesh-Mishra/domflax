/**
 * domflax — the programmatic ENGINE ({@link createDomflax}).
 *
 * Wires a real single-file pipeline: the JSX/TSX frontend + a Tailwind resolver feed the core pass
 * manager (running {@link builtinPatterns}), whose output is reverse-emitted back to class tokens
 * and re-printed by the JSX backend. `.html`/`.htm` route to the parse5 HTML frontend/backend
 * (surgical span edits). Non-supported files pass through unchanged.
 */

import { createPipeline } from '@domflax/core';
import type { EncodedSourceMap, Pattern, Pipeline, StyleResolver } from '@domflax/core';
import { builtinPatterns } from '@domflax/patterns';
import { createTailwindResolver } from '@domflax/resolver-tailwind';
import { createCssResolver } from '@domflax/resolver-css';

import { isSupported, resolveOptions, withConfigFile } from './options';
import type { DomflaxOptions, ResolvedDomflaxOptions } from './options';
import { htmlKindOf, jsxKindOf, runHtmlPipeline, runJsxPipeline } from './pipeline-run';
import { zeroStats } from './summary';
import type { FileStatDelta } from './summary';

/** Result of a single-file transform. `map` is null until codegen lands. */
export interface DomflaxTransformResult {
  readonly code: string;
  readonly map: EncodedSourceMap | null;
  /**
   * Per-file optimization delta (nodes removed / classes saved / bytes saved, plus the BEFORE
   * totals feeding the audit score). Zeroed for unsupported or unchanged files. Consumed by the
   * build adapters to accumulate the build-end summary / audit box.
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

/**
 * Build a configured domflax engine. A discovered `domflax.config.*` (see
 * {@link withConfigFile}) is merged UNDER the inline options unless `configFile: false`.
 */
export function createDomflax(options: DomflaxOptions = {}): Domflax {
  const resolved = resolveOptions(withConfigFile(options));
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
