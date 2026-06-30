/**
 * @domflax/cli — input discovery.
 *
 * A positional may be a folder (recursively scanned for .jsx/.tsx), a literal file, or a glob.
 * The `inputRoot` is the folder when a single directory is given (so `--out` can mirror structure),
 * otherwise `process.cwd()`.
 *
 * Only `.jsx`/`.tsx` are optimized today. `.html`/`.htm` are recognized solely so we can emit a
 * helpful hint (HTML optimization is a roadmap item) instead of silently finding nothing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Extensions the CLI will actually optimize. */
export const SUPPORTED_EXTS: readonly string[] = ['.jsx', '.tsx'];

/** Recognized but not yet optimizable — used only to drive a helpful "HTML isn't supported yet" hint. */
const HTML_EXTS: readonly string[] = ['.html', '.htm'];

/** Directories never descended into during a recursive folder scan. */
const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git', 'domflax-out']);

function isSupported(file: string): boolean {
  const lower = file.toLowerCase();
  return SUPPORTED_EXTS.some((ext) => lower.endsWith(ext));
}

function isHtml(file: string): boolean {
  const lower = file.toLowerCase();
  return HTML_EXTS.some((ext) => lower.endsWith(ext));
}

function hasGlobMagic(p: string): boolean {
  return /[*?[\]{}]/.test(p);
}

/** Recursively collect supported files under a directory; tally recognized-but-unsupported HTML. */
function walkDir(dir: string, out: string[], counts: { html: number }): void {
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
      walkDir(full, out, counts);
    } else if (entry.isFile()) {
      if (isSupported(entry.name)) out.push(full);
      else if (isHtml(entry.name)) counts.html += 1;
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
  const counts = { html: 0 };
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
      walkDir(path.resolve(p), files, counts);
      continue;
    }
    if (stat?.isFile()) {
      if (isSupported(p)) push(p);
      else if (isHtml(p)) counts.html += 1;
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
      counts.html += matched.filter(isHtml).length;
      if (supported.length === 0) warnings.push(`no .jsx/.tsx files matched: ${p}`);
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

  // Helpful hint: someone pointed domflax at HTML (often a built `dist/`). domflax optimizes JSX/TSX
  // source today; HTML optimization is on the roadmap.
  if (deduped.length === 0 && counts.html > 0) {
    warnings.push(
      `found ${counts.html} .html file${counts.html === 1 ? '' : 's'} but HTML optimization isn't supported yet ` +
        `(domflax currently optimizes .jsx/.tsx source; HTML is on the roadmap: ` +
        `https://github.com/Krishnesh-Mishra/domflax#roadmap).`,
    );
  }

  return { files: deduped, inputRoot, warnings };
}
