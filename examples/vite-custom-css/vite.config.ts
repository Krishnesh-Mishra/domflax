import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
// domflax's adapters (`vite` / `webpack`) are named exports; the default export is the
// programmatic `createDomflax` factory. A namespace import gives a single `domflax`
// binding that exposes `domflax.vite(...)` (and `domflax.webpack(...)`).
import * as domflax from 'domflax';

// domflax runs as a `enforce: 'pre'` source transform on .jsx/.tsx BEFORE the
// React plugin lowers JSX to createElement calls. With `provider: 'custom'` it
// resolves class names against the hand-written stylesheet(s) in `cssFiles`
// (parsed via postcss) rather than Tailwind.
export default defineConfig({
  plugins: [
    // Cast: domflax types its transform result with `readonly` source-map arrays, which are
    // structurally compatible with Vite's Plugin at runtime but stricter than Vite's mutable
    // type. The cast keeps the config type-correct without depending on Vite's internals.
    domflax.vite({ provider: 'custom', cssFiles: ['./src/styles.css'] }) as PluginOption,
    react(),
  ],
});
