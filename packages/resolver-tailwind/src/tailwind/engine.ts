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

/** The FIRST major version whose engine internals this (Tailwind v3) resolver cannot drive. */
export const FIRST_UNSUPPORTED_MAJOR = 4;

/** The outcome of trying to load the project's Tailwind engine. */
export interface LoadedEngine {
  /** The synchronous forward/reverse engine, or `null` when it could not be built. */
  readonly engine: TwEngine | null;
  /** The resolved `tailwindcss` version, or `null` when the package could not be located at all. */
  readonly version: string | null;
  /**
   * SAFETY (Layer 1): set to the detected MAJOR when the project's `tailwindcss` is a version this
   * resolver cannot drive (>= {@link FIRST_UNSUPPORTED_MAJOR}, e.g. v4's rewritten engine). In that
   * case `engine` is `null` and — rather than silently resolving every class to empty and then
   * mis-optimizing — the resolver reports every token as UNKNOWN so files are left UNCHANGED, and
   * surfaces a one-time diagnostic. `null` for a supported/driveable (or absent) Tailwind.
   */
  readonly unsupportedMajor: number | null;
}

/** Parse the leading integer major from a semver-ish version string, or `null`. */
function majorOf(version: string): number | null {
  const m = /^\s*(\d+)/.exec(version);
  return m ? Number(m[1]) : null;
}

/**
 * Load a synchronous Tailwind engine for the given resolved config. Detects the project's
 * `tailwindcss` version FIRST: a MAJOR this resolver cannot drive (v4+) fails LOUDLY via
 * {@link LoadedEngine.unsupportedMajor} (engine `null`) instead of silently returning empty
 * resolutions. Any other initialization failure returns a `null` engine with no version.
 */
export function loadEngine(options: TailwindResolverConfig): LoadedEngine {
  const req = projectRequire(options.projectRoot);
  if (!req) return { engine: null, version: null, unsupportedMajor: null };

  // Read the version BEFORE touching the (v3-shaped) internals: v4 ships a different engine at
  // `dist/lib.js` and has no `lib/lib/*.js` CJS internals, so probing them would only throw — we want
  // to positively identify v4 and refuse to drive it, not fall through to a generic failure.
  let version: string | null = null;
  try {
    version = (req('tailwindcss/package.json') as { version: string }).version;
  } catch {
    return { engine: null, version: null, unsupportedMajor: null };
  }
  const major = majorOf(version);
  if (major !== null && major >= FIRST_UNSUPPORTED_MAJOR) {
    return { engine: null, version, unsupportedMajor: major };
  }

  try {
    const resolveConfig = req('tailwindcss/resolveConfig.js') as (c: unknown) => unknown;
    const { createContext } = req('tailwindcss/lib/lib/setupContextUtils.js') as {
      createContext: (config: unknown) => TwContext;
    };
    const { generateRules } = req('tailwindcss/lib/lib/generateRules.js') as {
      generateRules: (candidates: Set<string>, context: TwContext) => Array<[number, TwNode]>;
    };

    let userConfig: unknown = options.config ?? { content: [{ raw: '' }] };
    if (options.configPath !== undefined) {
      const loadConfig = req('tailwindcss/loadConfig.js') as (p: string) => unknown;
      userConfig = loadConfig(options.configPath);
    }
    const resolved = resolveConfig(userConfig);
    const context = createContext(resolved);

    return {
      engine: {
        version,
        context,
        generate(candidates: readonly string[]): TwNode[] {
          const rules = generateRules(new Set(candidates), context);
          return rules.map(([, node]) => node);
        },
      },
      version,
      unsupportedMajor: null,
    };
  } catch {
    return { engine: null, version, unsupportedMajor: null };
  }
}
