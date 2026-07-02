/**
 * domflax — the webpack build adapter (also the Next.js path).
 *
 * Returns a plugin whose `apply(compiler)` injects a pre-enforced `module.rule` that invokes the
 * domflax {@link ./webpack-loader loader} on every `.jsx`/`.tsx` module. The loader runs the SAME
 * lazy engine as `createDomflax` (no eager Tailwind/postcss load). In AUDIT mode the loader passes
 * every module through unchanged and the `done` hook prints the boxed audit score instead of the
 * optimization summary.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { printCompilationAudit } from './audit-bridge';
import { createDomflax } from './engine';
import { withConfigFile } from './options';
import type { DomflaxOptions } from './options';
import { printCompilationSummary } from './summary';

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
 * Tap a REAL webpack `Compiler`'s `done` hook to print the build-end summary (or, in audit mode,
 * the boxed audit score). The per-file stats were stashed on the `compilation` by the loader
 * (separate bundle) under a shared `Symbol.for` key; here we read + print them once. No-op if
 * `compiler` has no `done` hook (e.g. a bare config or a stub).
 */
function tapWebpackSummary(compiler: DomflaxWebpackCompiler, audit: boolean): void {
  const done = compiler.hooks?.done;
  if (typeof done?.tap !== 'function') return;
  done.tap('domflax', (stats: unknown) => {
    // `done` receives a `Stats` whose `.compilation` is the object the loader wrote to; some stubs
    // pass the compilation directly.
    const compilation = (stats as { compilation?: unknown } | null)?.compilation ?? stats;
    if (audit) printCompilationAudit(compilation);
    else printCompilationSummary(compilation);
  });
}

/**
 * Wire the summary printer. On a real `Compiler` we tap `done` directly. On Next's bare config (no
 * `hooks`) we push a child plugin onto `config.plugins`; webpack later calls its `apply(compiler)`
 * with the real `Compiler`, at which point we tap `done`.
 */
function installWebpackSummary(
  compiler: DomflaxWebpackCompiler,
  host: DomflaxWebpackModuleHost,
  audit: boolean,
): void {
  if (typeof compiler.hooks?.done?.tap === 'function') {
    tapWebpackSummary(compiler, audit);
    return;
  }
  const plugins = (host.plugins ??= []);
  if (Array.isArray(plugins)) {
    plugins.push({ apply: (real: DomflaxWebpackCompiler) => tapWebpackSummary(real, audit) });
  }
}

/**
 * webpack adapter (also the Next.js path).
 *
 * A `domflax.config.{js,mjs,cjs,json}` (nearest, upward from `projectRoot`/cwd) is merged UNDER the
 * inline options ONCE here; the merged result is forwarded to the loader so both bundles agree.
 * Pass `configFile: false` to disable discovery.
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
export function webpack(options: DomflaxOptions = {}): DomflaxWebpackPlugin {
  // Merge the config file once; the loader receives the merged options (configFile: false).
  const merged = withConfigFile(options);
  // Validate options eagerly (parity with the other adapters); the resolver stays lazy.
  createDomflax(merged);
  const audit = merged.audit === true;
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
        use: [{ loader: webpackLoaderPath(), options: merged }],
      };
      rules.push(rule);
      // Print the aggregate summary / audit box at build end (loader ↔ plugin bridge).
      installWebpackSummary(compiler, host, audit);
    },
  };
}
