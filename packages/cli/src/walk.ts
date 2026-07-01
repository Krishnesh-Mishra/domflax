/**
 * @domflax/cli — input discovery.
 *
 * A positional may be a folder (recursively scanned for .jsx/.tsx/.html), a literal file, or a glob.
 * The `inputRoot` is the folder when a single directory is given (so `--out` can mirror structure),
 * otherwise `process.cwd()`.
 *
 * `.jsx`/`.tsx` (JSX frontend) and `.html`/`.htm` (parse5 frontend) are all optimized.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Extensions the CLI will actually optimize. */
export const SUPPORTED_EXTS: readonly string[] = ['.jsx', '.tsx', '.html', '.htm'];

/** Directories never descended into during a recursive folder scan. */
const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git', 'domflax-out']);

function isSupported(file: string): boolean {
  const lower = file.toLowerCase();
  return SUPPORTED_EXTS.some((ext) => lower.endsWith(ext));
}

function hasGlobMagic(p: string): boolean {
  return /[*?[\]{}]/.test(p);
}

/** Recursively collect supported files under a directory. */
function walkDir(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkDir(full, out);
    } else if (entry.isFile()) {
      if (isSupported(entry.name)) out.push(full);
    }
  }
}

/** Optional `fs.globSync` (Node 22+); accessed defensively so older runtimes degrade gracefully. */
type GlobSync = (pattern: string) => string[];
function globSyncMaybe(): GlobSync | null {
  const g = (fs as { globSync?: GlobSync }).globSync;
  return typeof g === 'function' ? g : null;
}

export interface Discovery {
  readonly files: readonly string[];
  readonly inputRoot: string;
  readonly warnings: readonly string[];
}

/**
 * Resolve positionals into a concrete, de-duplicated file list plus the mirror root for `--out`.
 */
export function discoverInputs(paths: readonly string[]): Discovery {
  const files: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const push = (f: string): void => {
    const abs = path.resolve(f);
    if (!seen.has(abs)) {
      seen.add(abs);
      files.push(abs);
    }
  };

  let inputRoot = process.cwd();
  if (paths.length === 1) {
    try {
      if (fs.statSync(paths[0]!).isDirectory()) inputRoot = path.resolve(paths[0]!);
    } catch {
      /* not a directory / missing — handled per-path below */
    }
  }

  for (const p of paths) {
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(p);
    } catch {
      stat = null;
    }

    if (stat?.isDirectory()) {
      // walkDir pushes directly; the final de-dupe pass below collapses any overlap.
      walkDir(path.resolve(p), files);
      continue;
    }
    if (stat?.isFile()) {
      if (isSupported(p)) push(p);
      else warnings.push(`unsupported file type, skipped: ${p}`);
      continue;
    }
    if (hasGlobMagic(p)) {
      const glob = globSyncMaybe();
      if (!glob) {
        warnings.push(`glob not supported on this Node version, skipped: ${p}`);
        continue;
      }
      const matched = glob(p);
      const supported = matched.filter(isSupported);
      if (supported.length === 0) warnings.push(`no .jsx/.tsx/.html files matched: ${p}`);
      for (const m of supported) push(m);
      continue;
    }
    warnings.push(`no such file or directory: ${p}`);
  }

  // De-duplicate (walkDir bypassed `push`).
  const deduped: string[] = [];
  const finalSeen = new Set<string>();
  for (const f of files) {
    const abs = path.resolve(f);
    if (!finalSeen.has(abs)) {
      finalSeen.add(abs);
      deduped.push(abs);
    }
  }

  return { files: deduped, inputRoot, warnings };
}
