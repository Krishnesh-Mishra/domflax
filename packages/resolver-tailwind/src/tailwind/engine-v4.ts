/**
 * @domflax/resolver-tailwind — Tailwind v4 engine adapter.
 *
 * Builds a {@link TwEngine} (the SAME interface the v3 path exposes) backed by a synchronous snapshot
 * of the project's real v4 design system (see {@link runV4Bridge}). Because it satisfies `TwEngine`
 * exactly — `version`, `context.getClassList()`, `generate(candidates)` — the resolver, extractor,
 * emitter and serializer all work UNCHANGED; the only v4-specific step is parsing each utility's CSS
 * ({@link parseUtilityCss}), which yields the identical flat {@link TwNode} shape v3 produces.
 *
 * SAFETY: if the snapshot cannot be built (no `@tailwindcss/node`, load error, timeout, …) this
 * returns `null` and the caller falls back to the fail-safe (every class UNKNOWN ⇒ files unchanged).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { runV4Bridge } from './v4-bridge';
import type { V4CssEntry } from './v4-bridge';
import type { TwEngine, TwNode } from './types';
import { parseUtilityCss } from './v4-css';

/** Directories worth scanning for the Tailwind CSS entry; anything else is skipped. */
const SEARCH_DIRS = ['', 'src', 'app', 'styles', 'src/styles', 'src/app', 'app/styles', 'assets/css', 'css'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage']);
const ENTRY_RE = /@import\s+["']tailwindcss["']|@tailwind\b|@theme\b/;

/** Shallowly scan one directory (non-recursive) for a `.css` file that looks like the TW entry. */
function scanDir(dir: string): V4CssEntry | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.css')) continue;
    const file = path.join(dir, name);
    try {
      if (!statSync(file).isFile()) continue;
      const css = readFileSync(file, 'utf8');
      if (ENTRY_RE.test(css)) return { css, base: path.dirname(file) };
    } catch {
      /* unreadable file — skip */
    }
  }
  return null;
}

/**
 * Assemble the ordered CSS-entry candidates the bridge should try: the project's real Tailwind entry
 * (found by a bounded scan of a few conventional directories) first, then a minimal
 * `@import "tailwindcss";` default so a design system can still be loaded when no entry is found.
 */
export function findCssEntries(projectRoot: string): V4CssEntry[] {
  const out: V4CssEntry[] = [];
  const seen = new Set<string>();
  for (const rel of SEARCH_DIRS) {
    const dir = path.resolve(projectRoot, rel);
    if (seen.has(dir) || [...SKIP_DIRS].some((s) => dir.includes(`${path.sep}${s}`))) continue;
    seen.add(dir);
    const hit = scanDir(dir);
    if (hit) {
      out.push(hit);
      break; // first plausible entry wins (conventional dirs are ordered shallow → deep)
    }
  }
  out.push({ css: '@import "tailwindcss";', base: projectRoot });
  return out;
}

/**
 * Adapt a class→CSS snapshot into a {@link TwEngine}. Per-class CSS is parsed lazily (and cached) into
 * the flat {@link TwNode} shape shared with v3, so `generate([...])` is a lookup + parse.
 */
function makeV4Engine(entries: ReadonlyArray<readonly [string, string]>, version: string): TwEngine {
  const cssByClass = new Map<string, string>(entries.map(([name, css]) => [name, css] as const));
  const nodeCache = new Map<string, TwNode[]>();

  const nodesFor = (token: string): TwNode[] => {
    let cached = nodeCache.get(token);
    if (!cached) {
      const css = cssByClass.get(token);
      cached = css ? parseUtilityCss(css) : [];
      nodeCache.set(token, cached);
    }
    return cached;
  };

  return {
    version,
    context: {
      // The resolver keeps only string entries; we hand it the concrete class names directly.
      getClassList: () => [...cssByClass.keys()],
    },
    generate(candidates: readonly string[]): TwNode[] {
      const out: TwNode[] = [];
      for (const c of candidates) for (const n of nodesFor(c)) out.push(n);
      return out;
    },
  };
}

/**
 * Try to build a v4-backed {@link TwEngine} for the project. Returns `null` (⇒ fail-safe) when the
 * design-system snapshot cannot be produced. `version` is the already-detected `tailwindcss` version.
 */
export function loadV4Engine(projectRoot: string, version: string): TwEngine | null {
  const snapshot = runV4Bridge({ projectRoot, entries: findCssEntries(projectRoot) });
  if (!snapshot) return null;
  return makeV4Engine(snapshot.entries, version);
}
