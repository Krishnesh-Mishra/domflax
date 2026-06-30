import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'pattern-kit': 'src/pattern-kit.ts',
    verify: 'src/verify.ts',
    cli: 'src/cli.ts',
    // Bundled webpack loader — webpack requires it by absolute path (see `webpack()` in src/index.ts).
    'webpack-loader': 'src/webpack-loader.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  // Inject a CJS-safe `import.meta.url` (esbuild otherwise leaves it `undefined` in the CJS bundle),
  // so `webpackLoaderPath()` — which derives the loader path from `import.meta.url` — works when
  // `domflax` is loaded via `require('domflax')` from a CommonJS `next.config.js`.
  shims: true,
  // Inline the private @domflax/* workspace packages into this bundle so `domflax` ships as a
  // single self-contained package (the @domflax/* packages are never published).
  noExternal: [/^@domflax\//],
  // Keep playwright + its (partially unbundleable) chromium-bidi engine OUT of the bundle. The USER
  // transform (`index`/`cli`) never references them — they are reached ONLY by the opt-in `verify`
  // subpath (`@domflax/verify`), which requires them at runtime from `@domflax/verify`'s own dep.
  // (playwright was previously auto-externalized as an optional peer; it is no longer a peer of the
  // browser-free transform, so it must be externalized explicitly here.)
  external: ['playwright', 'playwright-core', 'chromium-bidi'],
});
