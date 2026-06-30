// next.config.js (CommonJS — Next.js loads this with `require`).
//
// Wire domflax's webpack adapter so every .jsx/.tsx module is run through the domflax source
// transform before the build proceeds. domflax flattens redundant DOM wrappers and compresses
// verbose Tailwind class sets at compile time, while leaving dynamic / async content untouched.
//
// IMPORTANT: this targets the **webpack** builder. `next build` uses webpack by default, so
// `npm run build` exercises the adapter. Turbopack (`next dev --turbopack`) does NOT yet accept
// arbitrary webpack loaders, so the adapter is a no-op there — use the webpack path for now.
//
// ── Loading domflax ───────────────────────────────────────────────────────────────────────────
// The documented usage is simply:
//
//     const domflax = require('domflax');
//
// In this monorepo example we load domflax's ESM entry (`dist/index.js`) explicitly via its
// resolved path. The reason: domflax's current CommonJS bundle resolves its webpack loader path
// from `import.meta.url`, which is `undefined` under CommonJS — so the plain `require('domflax')`
// path throws during `webpack(config)`. The ESM bundle carries a valid `import.meta.url`, and
// Node (>=22) supports `require()`-ing an ES module, so this stays a CommonJS config file.
const path = require('path');
const domflaxDir = path.dirname(require.resolve('domflax/package.json'));
const domflax = require(path.join(domflaxDir, 'dist', 'index.js'));

/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack(config) {
    // `domflax.webpack(...)` returns a real webpack plugin. Pushing it into `config.plugins`
    // lets webpack invoke its `apply(compiler)` with the real Compiler, where the plugin appends
    // a pre-enforced `module.rule` (`compiler.options.module.rules`) that runs the domflax loader
    // on every `.jsx`/`.tsx` module. (Equivalent to `domflax.webpack(opts).apply({ options: config })`.)
    config.plugins.push(domflax.webpack({ provider: 'tailwind' }));
    return config;
  },
};

module.exports = nextConfig;
