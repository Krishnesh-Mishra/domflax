/**
 * @domflax/cli — OUTPUT SAFETY (DESIGN-DECISIONS Q16, ARCHITECTURE §16.10).
 *
 * Source is READ-ONLY by default. Writes land in `--out`/`./domflax-out` (mirroring structure), or in
 * place ONLY inside disposable build dirs (dist/build/out/.next). Overwriting real source in place
 * requires `--dangerously-overwrite-source` AND a clean git tree (skippable with `--no-git-check`).
 * `--dry-run` writes nothing.
 */

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

import type { CliOptions } from './options';

/** Disposable build directories where in-place overwrite is always safe (they are regenerated). */
const DISPOSABLE_DIRS: ReadonlySet<string> = new Set(['dist', 'build', 'out', '.next']);

/** True when any path segment is a disposable build dir, so the file is a regenerable artifact. */
export function isDisposablePath(file: string): boolean {
  return path
    .resolve(file)
    .split(path.sep)
    .some((seg) => DISPOSABLE_DIRS.has(seg));
}

export type WriteMode = 'out-dir' | 'overwrite-source';

/** Invocation-level write plan shared by every file. */
export interface WritePlan {
  readonly mode: WriteMode;
  /** Resolved absolute output dir for `out-dir` mode; `null` when overwriting source in place. */
  readonly outDir: string | null;
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/** Run `git status --porcelain`; clean ⇒ true. A non-repo / missing git ⇒ false (fail safe). */
export function isGitClean(cwd: string): boolean {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().length === 0;
  } catch {
    return false;
  }
}

/**
 * Resolve the invocation-level {@link WritePlan}. In-place source overwrite is refused unless the
 * danger flag is set and (the git tree is clean OR the git check is waived).
 */
export function planWrites(options: CliOptions, gitClean: boolean): Result<WritePlan> {
  if (options.dangerouslyOverwriteSource) {
    if (!options.noGitCheck && !gitClean) {
      return {
        ok: false,
        error:
          'refusing --dangerously-overwrite-source: git working tree is not clean. ' +
          'Commit or stash first, or pass --no-git-check to override.',
      };
    }
    return { ok: true, value: { mode: 'overwrite-source', outDir: null } };
  }
  const outDir = path.resolve(options.out ?? 'domflax-out');
  return { ok: true, value: { mode: 'out-dir', outDir } };
}

/**
 * Compute the destination path for one source file under a {@link WritePlan}. Refuses when an
 * `out-dir` destination resolves onto the source file itself and that file is NOT a disposable build
 * artifact — that would be an unsanctioned in-place source overwrite (the Q16 guard).
 */
export function destinationFor(file: string, inputRoot: string, plan: WritePlan): Result<string> {
  const absFile = path.resolve(file);

  if (plan.mode === 'overwrite-source') {
    // Already gated by planWrites (danger flag + clean-git / waiver).
    return { ok: true, value: absFile };
  }

  const outDir = plan.outDir!;
  const rel = path.relative(inputRoot, absFile);
  // Inputs outside the mirror root collapse to their basename so we never escape outDir with `..`.
  const safeRel = rel === '' || rel.startsWith('..') || path.isAbsolute(rel) ? path.basename(absFile) : rel;
  const dest = path.join(outDir, safeRel);

  if (path.resolve(dest) === absFile && !isDisposablePath(absFile)) {
    return {
      ok: false,
      error:
        `refusing to overwrite source file ${absFile}: the output path resolves onto the source. ` +
        'Choose a different --out, or pass --dangerously-overwrite-source (with a clean git tree).',
    };
  }
  return { ok: true, value: dest };
}
