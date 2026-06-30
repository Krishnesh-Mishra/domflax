import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  // Inject a real `import.meta.url` in the CJS bin (esbuild otherwise stubs it as `{}`), so the
  // entry-point self-detection that auto-runs `main()` works when executed as `domflax-cli`.
  shims: true,
});
