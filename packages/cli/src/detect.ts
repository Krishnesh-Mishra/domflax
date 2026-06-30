/**
 * @domflax/cli — project auto-detection for the interactive wizard (Q17 convenience).
 *
 * Pure, root-relative scanners used to PRE-FILL wizard prompts so the user doesn't have to type
 * CSS paths or source folders by hand. These are wizard conveniences only — the flag/non-interactive
 * path never calls them, so detection can never change a scripted invocation's behavior.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Directories never descended into when scanning for CSS (build output, vendored deps, VCS). */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  'out',
  'coverage',
  '.git',
  'domflax-out',
]);

/** Common source folders we suggest as inputs, in the order they're offered. */
const COMMON_INPUT_DIRS: readonly string[] = ['src', 'app', 'components', 'pages', 'lib', 'ui', 'public'];

/** Upper bound on detected CSS files surfaced in the wizard, so huge repos stay responsive. */
const CSS_FILE_CAP = 200;

/** Default recursion depth when scanning for CSS (the given folder + up to this many nested levels). */
const DEFAULT_CSS_DEPTH = 10;

/** Normalize an absolute path to a forward-slash, root-relative path (stable across platforms). */
function toRelative(root: string, abs: string): string {
  const rel = path.relative(root, abs);
  return rel.split(path.sep).join('/');
}

/**
 * Recursively collect `*.css` files, returning paths relative to `root` (forward-slashed, sorted,
 * de-duplicated). Scans the project `root` AND each folder in `scanRoots` (the explicitly-given
 * input folder), descending up to `maxDepth` nested levels. {@link SKIP_DIRS} (build output, deps,
 * VCS) are skipped while descending, but an explicitly-given `scanRoots` entry is ALWAYS scanned even
 * if it's a `dist`/`build` folder — if the user pointed domflax there, its stylesheets count.
 * Capped at {@link CSS_FILE_CAP} (logs to stderr on truncation). Missing/unreadable dirs are skipped;
 * never throws.
 */
export function detectCssFiles(
  root: string,
  scanRoots: readonly string[] = [],
  maxDepth: number = DEFAULT_CSS_DEPTH,
): string[] {
  const base = path.resolve(root);
  const found = new Map<string, string>(); // absolute path -> root-relative path (natural de-dupe)
  let capped = false;

  const walk = (dir: string, depth: number): void => {
    if (capped || depth > maxDepth) return;
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
        walk(full, depth + 1);
        if (capped) return;
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.css')) {
        const abs = path.resolve(full);
        if (!found.has(abs)) {
          found.set(abs, toRelative(base, abs));
          if (found.size >= CSS_FILE_CAP) {
            capped = true;
            return;
          }
        }
      }
    }
  };

  // Project root (skips build/dep dirs), then each explicitly-given input folder (scanned directly,
  // so a `dist`/`build` input is still searched). Each is bounded to `maxDepth` nested levels.
  walk(base, 0);
  for (const r of scanRoots) {
    if (capped) break;
    const abs = path.resolve(r);
    if (abs !== base) walk(abs, 0);
  }

  const list = [...found.values()].sort((a, b) => a.localeCompare(b));
  if (capped) {
    console.error(`domflax: more than ${CSS_FILE_CAP} CSS files found; showing the first ${CSS_FILE_CAP}.`);
  }
  return list;
}

/**
 * Return the subset of {@link COMMON_INPUT_DIRS} that exist as directories directly under `root`,
 * as root-relative paths (preserving the suggestion order). Never throws.
 */
export function detectInputDirs(root: string): string[] {
  const resolved = path.resolve(root);
  return COMMON_INPUT_DIRS.filter((name) => {
    try {
      return fs.statSync(path.join(resolved, name)).isDirectory();
    } catch {
      return false;
    }
  });
}
