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

/** Normalize an absolute path to a forward-slash, root-relative path (stable across platforms). */
function toRelative(root: string, abs: string): string {
  const rel = path.relative(root, abs);
  return rel.split(path.sep).join('/');
}

/**
 * Recursively collect `*.css` files under `root` (excluding {@link SKIP_DIRS}), returning
 * root-relative, forward-slashed, sorted paths. Capped at {@link CSS_FILE_CAP} — logs to stderr if
 * the cap truncates the list. Missing/unreadable dirs yield an empty list (never throws).
 */
export function detectCssFiles(root: string): string[] {
  const found: string[] = [];
  let capped = false;

  const walk = (dir: string): void => {
    if (capped) return;
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
        walk(full);
        if (capped) return;
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.css')) {
        found.push(toRelative(root, full));
        if (found.length >= CSS_FILE_CAP) {
          capped = true;
          return;
        }
      }
    }
  };

  walk(path.resolve(root));
  found.sort((a, b) => a.localeCompare(b));
  if (capped) {
    console.error(`domflax: more than ${CSS_FILE_CAP} CSS files found; showing the first ${CSS_FILE_CAP}.`);
  }
  return found;
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
