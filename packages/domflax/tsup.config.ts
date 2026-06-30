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
  // Inline the private @domflax/* workspace packages into this bundle so `domflax` ships as a
  // single self-contained package (the @domflax/* packages are never published).
  noExternal: [/^@domflax\//],
});
