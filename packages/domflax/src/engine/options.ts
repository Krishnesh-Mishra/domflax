/**
 * domflax — adapter/factory OPTIONS: the shared {@link DomflaxConfig}-based option type, defaults,
 * and the config-file merge ({@link withConfigFile}).
 *
 * Split out of `index.ts` so the barrel + adapters stay focused. The config machinery itself
 * (discovery + loading + the `DomflaxConfig` type) lives in `@domflax/cli/config-file` and is
 * bundled into this package — ONE implementation serves `npx domflax`, `domflax.vite()` and
 * `domflax.webpack()`.
 */

import { findConfigFile, loadConfigFileSync } from '@domflax/cli/config-file';
import type { DomflaxConfig } from '@domflax/cli/config-file';
import type { SafetyLevel } from '@domflax/core';

/** How class names resolve to computed styles. */
export type DomflaxProvider = 'auto' | 'tailwind' | 'custom';

/**
 * Public adapter/factory options (the documented `domflax({...})` surface).
 *
 * Extends the shared {@link DomflaxConfig} — the exact shape of a `domflax.config.{js,mjs,cjs,json}`
 * file — so users can keep ONE typed config and spread it inline:
 *
 * ```ts
 * import domflax, { type DomflaxConfig } from 'domflax';
 * const shared: DomflaxConfig = { provider: 'tailwind', safety: 2 };
 * export default { plugins: [domflax.vite({ ...shared, dryRun: true })] };
 * ```
 *
 * Precedence: inline options > discovered config file > defaults.
 */
export interface DomflaxOptions extends DomflaxConfig {
  /**
   * Config-file behaviour: `undefined` (default) discovers the nearest
   * `domflax.config.{js,mjs,cjs,json}` upward from {@link DomflaxConfig.projectRoot} (or the cwd)
   * and merges it UNDER the inline options; `false` disables discovery entirely; a string loads
   * that exact file.
   */
  readonly configFile?: false | string;
}

/** Fully-resolved options with defaults applied. */
export interface ResolvedDomflaxOptions {
  readonly provider: DomflaxProvider;
  readonly cssFiles: readonly string[];
  readonly dryRun: boolean;
  /** AUDIT mode: adapters pass modules through unchanged and report a score at build end. */
  readonly audit: boolean;
  readonly safety: SafetyLevel;
  readonly include: readonly string[];
}

export const DEFAULT_INCLUDE: readonly string[] = ['.jsx', '.tsx', '.html', '.htm'];

/**
 * Merge a discovered (or explicitly named) config file UNDER the inline options: every inline
 * value wins; anything inline leaves unset falls back to the file. Returns the input unchanged
 * when discovery is disabled (`configFile: false`) or no file exists. The returned object carries
 * `configFile: false` so downstream factories never re-discover.
 */
export function withConfigFile(options: DomflaxOptions = {}): DomflaxOptions {
  if (options.configFile === false) return options;
  const file =
    typeof options.configFile === 'string'
      ? options.configFile
      : findConfigFile(options.projectRoot ?? process.cwd());
  if (file === null) return options;

  const fileConfig = loadConfigFileSync(file);
  const merged: Record<string, unknown> = { ...fileConfig };
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) merged[key] = value;
  }
  merged['configFile'] = false; // already applied — callees must not discover again
  return merged as DomflaxOptions;
}

/** Apply defaults. `cssFiles` (plugin spelling) and `css` (CLI spelling) are aliases. */
export function resolveOptions(options: DomflaxOptions): ResolvedDomflaxOptions {
  return {
    provider: options.provider ?? 'auto',
    cssFiles: options.cssFiles ?? options.css ?? [],
    dryRun: options.dryRun ?? false,
    audit: options.audit ?? false,
    safety: options.safety ?? 2,
    include: options.include ?? DEFAULT_INCLUDE,
  };
}

/** True when `id` is a file domflax knows how to transform. */
export function isSupported(id: string, include: readonly string[]): boolean {
  // Strip query suffixes bundlers append (e.g. `App.tsx?used`).
  const clean = id.split('?', 1)[0] ?? id;
  return include.some((ext) => clean.endsWith(ext));
}
