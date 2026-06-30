/**
 * @domflax/resolver-tailwind — engine loading (synchronous v3 internals).
 *
 * The forward/reverse engine lives in tailwindcss' CommonJS internals. We load them through
 * `createRequire` (rather than `import`) so the exact same code path works whether this module is
 * bundled to ESM or CJS, and so the untyped internal subpaths don't need ambient declarations.
 *
 * CRITICAL (bundling): tailwindcss must be resolved from the CONSUMER'S project, NOT from the file
 * this module happens to live in. When `domflax` inlines this resolver into its own bundle
 * (`noExternal: [/^@domflax\//]`), a require based on the bundle's location (`__filename`) would
 * look for `tailwindcss` next to `domflax/dist`, where it does not exist — so the engine silently
 * failed to load and `emit`'s reverse index came up empty. Instead we root the require in the user's
 * project (an explicit project root, then `process.cwd()`), exactly how prettier-plugin-tailwindcss
 * and the Tailwind IntelliSense engine locate a project's Tailwind. The bundle/source location is
 * kept only as a last-resort fallback (covers the non-bundled / in-repo dev case). The first base
 * from which `tailwindcss/package.json` resolves wins.
 */

import { createRequire } from 'node:module';
import * as path from 'node:path';

import type { TailwindResolverConfig } from './config';
import type { TwContext, TwEngine, TwNode } from './types';

/**
 * This module's own location, used as a last-resort require base. esbuild substitutes a real
 * `__filename` in a CJS bundle; in an ESM bundle `__filename` is undefined and we fall back to
 * `import.meta.url` (a `file://` URL, which `createRequire` accepts).
 */
function moduleBase(): string {
  return typeof __filename === 'string' ? __filename : import.meta.url;
}

/**
 * Build a `require` rooted in the consumer's project so engine resolution is independent of where
 * this (possibly bundled) module physically lives. Returns `null` if `tailwindcss` resolves from no
 * candidate base.
 */
function projectRequire(projectRoot?: string): NodeRequire | null {
  const bases: string[] = [];
  // A real file name is irrelevant — `createRequire` only uses the containing directory for
  // resolution; the file need not exist.
  if (projectRoot) bases.push(path.join(projectRoot, '__domflax__.js'));
  bases.push(path.join(process.cwd(), '__domflax__.js'));
  bases.push(moduleBase());
  for (const base of bases) {
    try {
      const candidate = createRequire(base);
      candidate.resolve('tailwindcss/package.json');
      return candidate;
    } catch {
      /* try the next base */
    }
  }
  return null;
}

/** Build a synchronous Tailwind v3 engine for the given resolved config; returns `null` on failure. */
export function loadEngine(options: TailwindResolverConfig): TwEngine | null {
  const req = projectRequire(options.projectRoot);
  if (!req) return null;
  try {
    const resolveConfig = req('tailwindcss/resolveConfig.js') as (c: unknown) => unknown;
    const { createContext } = req('tailwindcss/lib/lib/setupContextUtils.js') as {
      createContext: (config: unknown) => TwContext;
    };
    const { generateRules } = req('tailwindcss/lib/lib/generateRules.js') as {
      generateRules: (candidates: Set<string>, context: TwContext) => Array<[number, TwNode]>;
    };
    const pkg = req('tailwindcss/package.json') as { version: string };

    let userConfig: unknown = options.config ?? { content: [{ raw: '' }] };
    if (options.configPath !== undefined) {
      const loadConfig = req('tailwindcss/loadConfig.js') as (p: string) => unknown;
      userConfig = loadConfig(options.configPath);
    }
    const resolved = resolveConfig(userConfig);
    const context = createContext(resolved);

    return {
      version: pkg.version,
      context,
      generate(candidates: readonly string[]): TwNode[] {
        const rules = generateRules(new Set(candidates), context);
        return rules.map(([, node]) => node);
      },
    };
  } catch {
    return null;
  }
}
