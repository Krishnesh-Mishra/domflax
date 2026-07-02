/**
 * domflax — shared config-file support (`domflax.config.{js,mjs,cjs,json}`).
 *
 * ONE typed config ({@link DomflaxConfig}) covers the union of the build-plugin options
 * (`provider`, `cssFiles`, `safety`, `include`, `dryRun`, `audit`, …) and the CLI options
 * (`out`, `css`, `maxMemory`, `concurrency`, `details`, `report`, `passes`, …), so a single
 * `domflax.config.js` can drive `npx domflax`, `domflax.vite()` and `domflax.webpack()` alike.
 *
 * Precedence everywhere is: explicit flags / inline options  >  config file  >  built-in defaults.
 *
 * Discovery ({@link findConfigFile}) walks UPWARD from the starting directory (nearest file wins)
 * and stops at the filesystem root or at the first `package.json` boundary — deliberately simple,
 * no cosmiconfig. Loading ({@link loadConfigFileSync}) uses native `require` (Node ≥ 20.19 also
 * `require()`s ES modules) for `.js`/`.mjs`/`.cjs` — supporting BOTH `export default {...}` and
 * `module.exports = {...}` — and `JSON.parse` for `.json`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

import type { SafetyLevel } from '@domflax/core';

/** How class names resolve to computed styles (shared by the CLI and every build adapter). */
export type DomflaxConfigProvider = 'auto' | 'tailwind' | 'custom';

/**
 * The shared domflax configuration — the shape of a `domflax.config.{js,mjs,cjs,json}` file AND the
 * base of the plugin option objects (`domflax.vite({...})` / `domflax.webpack({...})` /
 * `createDomflax({...})` all accept a `DomflaxConfig`).
 *
 * Every field is optional; anything omitted falls back to the built-in default. Explicit CLI flags
 * and inline plugin options always override what the file says.
 *
 * ```js
 * // domflax.config.js
 * import { defineConfig } from 'domflax';
 * export default defineConfig({ provider: 'tailwind', safety: 2, out: 'domflax-out' });
 * ```
 *
 * Deliberately NOT configurable from a file (flags only, for safety):
 * `--dangerously-overwrite-source`, `--no-git-check`, `--yes` / `--no-interactive`.
 */
export interface DomflaxConfig {
  /** Style resolution strategy. Default: `'auto'` (Tailwind). */
  readonly provider?: DomflaxConfigProvider;
  /** Stylesheets to parse when `provider` is `'custom'` (plugin spelling; alias of {@link css}). */
  readonly cssFiles?: readonly string[];
  /** Stylesheets to parse when `provider` is `'custom'` (CLI spelling; alias of {@link cssFiles}). */
  readonly css?: readonly string[];
  /** File extensions the build adapters consider. Default: `.jsx`/`.tsx`/`.html`/`.htm`. */
  readonly include?: readonly string[];
  /** Optimization aggressiveness handed to the pass manager (0 lint … 3 aggressive). Default: 2. */
  readonly safety?: SafetyLevel;
  /** Preview changes without rewriting anything. Default: false. */
  readonly dryRun?: boolean;
  /**
   * AUDIT mode: analyze + score only. The CLI prints a 0–100 DOM-efficiency score instead of
   * diffs and writes NOTHING; the build plugins pass every module through UNCHANGED and print the
   * audit box at build end instead of the optimization summary. Default: false.
   */
  readonly audit?: boolean;
  /** CLI output directory (`--out`). Default: `./domflax-out`. */
  readonly out?: string;
  /** CLI: print the run summary (`--report`). Default: false. */
  readonly report?: boolean;
  /** CLI: print per-file optimization stats (`--details`). Default: false. */
  readonly details?: boolean;
  /** CLI: restrict to these pass/pattern names. Default: every built-in pattern. */
  readonly passes?: readonly string[];
  /** Root to resolve the Tailwind/postcss engines from (`--project-root`). Default: cwd. */
  readonly projectRoot?: string;
  /** CLI worker-pool memory budget in MB (`--max-memory`). Default: ~70% of free RAM. */
  readonly maxMemory?: number;
  /** CLI hard cap on parallel workers (`--concurrency`). Default: auto (CPU/memory bound). */
  readonly concurrency?: number;
}

/**
 * Identity helper for `domflax.config.js` — gives users IntelliSense / type-checking on the config
 * object without importing any runtime machinery:
 *
 * ```js
 * // domflax.config.mjs
 * import { defineConfig } from 'domflax';
 * export default defineConfig({ provider: 'custom', cssFiles: ['src/styles.css'] });
 * ```
 */
export function defineConfig(config: DomflaxConfig): DomflaxConfig {
  return config;
}

/** The recognized config file names, in lookup order (first hit in a directory wins). */
export const CONFIG_FILE_NAMES: readonly string[] = [
  'domflax.config.js',
  'domflax.config.mjs',
  'domflax.config.cjs',
  'domflax.config.json',
];

/**
 * Find the nearest config file, walking UPWARD from `startDir` (default: cwd). Per directory the
 * {@link CONFIG_FILE_NAMES} are checked in order; the first existing file wins. The walk stops at
 * the filesystem root or at the first directory containing a `package.json` (the project boundary —
 * a config in the SAME directory as the `package.json` is still found, since config names are
 * checked before the boundary). Returns the absolute path, or `null` when nothing was found.
 */
export function findConfigFile(startDir: string = process.cwd()): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    for (const name of CONFIG_FILE_NAMES) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    // Project boundary: don't escape past the nearest package.json.
    if (existsSync(path.join(dir, 'package.json'))) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
}

/** Unwrap a module's config object: `export default {...}` or a plain `module.exports = {...}`. */
function unwrapModule(raw: unknown): unknown {
  if (raw !== null && typeof raw === 'object' && 'default' in raw) {
    const def = (raw as { default: unknown }).default;
    if (def !== null && typeof def === 'object') return def;
  }
  return raw;
}

/** Throw a uniform "not a config object" error. */
function assertConfigObject(value: unknown, file: string): asserts value is DomflaxConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `domflax: config file ${file} must export a plain object ` +
        '(export default {...} / module.exports = {...} / a JSON object)',
    );
  }
}

/**
 * Load one config file SYNCHRONOUSLY. `.json` is `JSON.parse`d; `.js`/`.mjs`/`.cjs` go through the
 * native `require` (which on Node ≥ 20.19 / ≥ 22.12 also loads ES modules, so `export default` in
 * an ESM config works). Supports `export default {...}` and `module.exports = {...}`. Throws with a
 * clear message on a missing file, a parse error, or a non-object export.
 */
export function loadConfigFileSync(file: string): DomflaxConfig {
  const abs = path.resolve(file);
  if (abs.endsWith('.json')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(abs, 'utf8'));
    } catch (err) {
      throw new Error(`domflax: cannot read config ${abs}: ${String((err as Error)?.message ?? err)}`);
    }
    assertConfigObject(parsed, abs);
    return parsed;
  }

  const requireFrom = createRequire(abs);
  let raw: unknown;
  try {
    raw = requireFrom(abs);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'ERR_REQUIRE_ESM' || code === 'ERR_REQUIRE_ASYNC_MODULE') {
      throw new Error(
        `domflax: cannot load ES-module config ${abs} on this Node version — ` +
          'rename it to domflax.config.cjs / domflax.config.json, or upgrade Node (>= 20.19).',
      );
    }
    throw new Error(`domflax: cannot load config ${abs}: ${String((err as Error)?.message ?? err)}`);
  }
  const config = unwrapModule(raw);
  assertConfigObject(config, abs);
  return config;
}

/** A discovered config: where it came from plus its parsed content. */
export interface DiscoveredConfig {
  /** Absolute path of the config file that was loaded. */
  readonly path: string;
  /** The parsed configuration object. */
  readonly config: DomflaxConfig;
}

/**
 * Convenience: {@link findConfigFile} + {@link loadConfigFileSync}. Returns `null` when no config
 * file exists between `startDir` and the project boundary; throws when a found file fails to load.
 */
export function discoverConfig(startDir?: string): DiscoveredConfig | null {
  const file = findConfigFile(startDir);
  if (file === null) return null;
  return { path: file, config: loadConfigFileSync(file) };
}
