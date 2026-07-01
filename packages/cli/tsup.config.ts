import { defineConfig } from 'tsup';

export default defineConfig({
  // `worker` is emitted as its OWN entry so `new Worker(...)` can load `worker.cjs`/`worker.js` at
  // runtime (both from this package's dist and when bundled into `domflax`'s dist).
  entry: { index: 'src/index.ts', worker: 'src/worker.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  // Inject a real `import.meta.url` in the CJS bin (esbuild otherwise stubs it as `{}`), so the
  // entry-point self-detection that auto-runs `main()` works when executed as `domflax-cli`.
  shims: true,
});
