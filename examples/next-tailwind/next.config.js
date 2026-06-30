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
// domflax's CommonJS bundle loads cleanly via the documented form below; its webpack loader path
// resolves correctly under `require`, so no ESM workaround is needed.
const domflax = require('domflax');

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
