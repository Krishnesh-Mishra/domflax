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
 *
 * Configuration: every surface (CLI, Vite, webpack, programmatic) shares ONE typed config —
 * {@link DomflaxConfig} — loadable from a `domflax.config.{js,mjs,cjs,json}` file (nearest file,
 * discovered upward from the project root; explicit flags/inline options always win). Use
 * {@link defineConfig} in the config file for IntelliSense.
 */

import { vite } from './adapter-vite';
import type { DomflaxVitePlugin } from './adapter-vite';
import { webpack } from './adapter-webpack';
import type { DomflaxWebpackPlugin } from './adapter-webpack';
import { createDomflax } from './engine';
import type { Domflax } from './engine';
import type { DomflaxOptions } from './options';

// ── Re-export the public surface ──────────────────────────────────────────────────────────────
export * from '@domflax/core';
export * from '@domflax/patterns';

// Shared config (ONE type for the config file, the CLI and every adapter) + the IntelliSense helper.
export { defineConfig } from '@domflax/cli/config-file';
export type { DomflaxConfig, DomflaxConfigProvider } from '@domflax/cli/config-file';

// Options + engine.
export { DEFAULT_INCLUDE, resolveOptions, withConfigFile } from './options';
export type { DomflaxOptions, DomflaxProvider, ResolvedDomflaxOptions } from './options';
export { createDomflax } from './engine';
export type { Domflax, DomflaxTransformResult } from './engine';

// Build adapters.
export { vite } from './adapter-vite';
export type { DomflaxVitePlugin } from './adapter-vite';
export { webpack } from './adapter-webpack';
export type { DomflaxWebpackCompiler, DomflaxWebpackPlugin } from './adapter-webpack';

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
