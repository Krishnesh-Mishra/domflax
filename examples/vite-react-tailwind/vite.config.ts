import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
// domflax's default export is the `createDomflax` factory; the bundler adapters
// (`vite` / `webpack`) are named exports, so we pull in the whole namespace and
// call `domflax.vite(...)` exactly as the docs describe.
import * as domflax from 'domflax';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    // domflax declares `enforce: 'pre'`, so it transforms the raw .tsx source
    // (flattening redundant wrappers + compressing class sets) BEFORE
    // @vitejs/plugin-react lowers JSX to React.createElement calls. Order matters:
    // domflax must come first so it sees plain JSX, not already-transformed code.
    // The cast bridges a purely type-level mismatch: domflax types its source map
    // with `readonly` arrays, while Vite's `SourceMapInput` expects mutable ones.
    // The plugin shape itself is structurally a valid Vite plugin.
    domflax.vite({ provider: 'auto' }) as unknown as PluginOption,
    react(),
  ],
});
