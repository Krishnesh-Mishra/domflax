/**
 * @domflax/cli — the real command-line entry point.
 *
 * Wires the transform engine ({@link createTransform}, built from the lower @domflax/* packages — it
 * deliberately never imports the `domflax` meta package, which would create a cycle) to file
 * discovery, OUTPUT SAFETY (Q16), and an optional interactive wizard (Q17). Usable as `npx domflax`
 * via the meta package's bin, and directly as the `domflax-cli` bin.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import type { CliOptions } from './options';
import { parseInvocation, shouldPrompt, USAGE } from './options';
import { computeWorkerCount, shouldUsePool, runPool, addStats, emptyTotals } from './pool';
import type { Totals } from './pool';
import { destinationFor, isGitClean, planWrites } from './safety';
import type { WritePlan } from './safety';
import { createTransform } from './transform';
import { discoverInputs } from './walk';
import { unifiedDiff } from './diff';
import { runWizard, WIZARD_CANCELLED } from './wizard';

// Re-export the public surface so consumers/tests reach it from the package root.
export type { CliOptions, ProviderOption } from './options';
export { parseInvocation, shouldPrompt, USAGE, DEFAULT_SAFETY } from './options';
export type { WritePlan, WriteMode } from './safety';
export { destinationFor, isDisposablePath, isGitClean, planWrites } from './safety';
export type { FileResult, FileStats, Transform } from './transform';
export { createTransform, buildResolver, builtinPatternNames } from './transform';
export { discoverInputs, SUPPORTED_EXTS } from './walk';
export { unifiedDiff } from './diff';

/** Outcome of a {@link run}: the process exit code. */
export interface RunResult {
  readonly exitCode: number;
}

function printReport(totals: Totals): void {
  console.log('');
  console.log('domflax report');
  console.log(`  files processed : ${totals.files}`);
  console.log(`  files changed   : ${totals.changed}`);
  console.log(`  nodes removed   : ${totals.nodesRemoved}`);
  console.log(`  classes saved   : ${totals.classesSaved}`);
  console.log(`  bytes saved     : ${totals.bytesSaved}`);
}

/**
 * The sequential (single-engine) path: build one transform and process every file in order. Used for
 * dry-run (ordered diffs), small jobs, and low-RAM runs (workers ≤ 1). Returns the failure count and
 * accumulates into `totals`.
 */
function runInline(
  files: readonly string[],
  options: CliOptions,
  inputRoot: string,
  plan: WritePlan,
  totals: Totals,
): number {
  const transform = createTransform(options);
  let failures = 0;

  for (const file of files) {
    let code: string;
    try {
      code = readFileSync(file, 'utf8');
    } catch (err) {
      console.error(`domflax: cannot read ${file}: ${String((err as Error)?.message ?? err)}`);
      failures += 1;
      continue;
    }

    const result = transform.transformFile(code, file);
    addStats(totals, result.stats, result.changed);

    if (options.dryRun) {
      const rel = path.relative(inputRoot, file) || path.basename(file);
      if (result.changed) console.log(unifiedDiff(code, result.code, rel));
      else if (!options.report) console.log(`  (unchanged) ${rel}`);
      continue;
    }

    if (!result.changed) continue;

    const target = destinationFor(file, inputRoot, plan);
    if (!target.ok) {
      console.error(`domflax: ${target.error}`);
      failures += 1;
      continue;
    }
    try {
      mkdirSync(path.dirname(target.value), { recursive: true });
      writeFileSync(target.value, result.code, 'utf8');
      console.log(`domflax: wrote ${path.relative(process.cwd(), target.value) || target.value}`);
    } catch (err) {
      console.error(`domflax: cannot write ${target.value}: ${String((err as Error)?.message ?? err)}`);
      failures += 1;
    }
  }
  return failures;
}

/**
 * Execute a fully-resolved {@link CliOptions}: discover inputs, enforce output safety, transform each
 * file, and either preview (dry-run), write to the mirrored output, or overwrite in place. Large
 * batches are processed by a memory-bounded worker pool; dry-run and small jobs run inline.
 */
export async function execute(options: CliOptions): Promise<RunResult> {
  const { files, inputRoot, warnings } = discoverInputs(options.paths);
  for (const w of warnings) console.error(`domflax: ${w}`);

  if (files.length === 0) {
    console.error('domflax: no .jsx/.tsx files found for the given paths');
    return { exitCode: 1 };
  }

  const projectRoot = options.projectRoot ?? process.cwd();
  const gitClean =
    options.dangerouslyOverwriteSource && !options.noGitCheck ? isGitClean(projectRoot) : true;

  const planned = planWrites(options, gitClean);
  if (!planned.ok) {
    console.error(`domflax: ${planned.error}`);
    return { exitCode: 1 };
  }
  const plan = planned.value;

  // Choose execution mode: a memory-bounded worker pool for large batches, else the inline path.
  // Dry-run always runs inline (ordered diffs), as does any small job (pool startup isn't worth it).
  const poolPlan = computeWorkerCount(options);
  const usePool = !options.dryRun && shouldUsePool(files.length, poolPlan);

  const totals: Totals = emptyTotals();
  let failures = 0;

  if (usePool) {
    const outcome = await runPool(
      files,
      { options, inputRoot, plan },
      poolPlan,
      // Per-file "wrote" lines are collected and printed in deterministic (sorted) order below.
    );
    Object.assign(totals, outcome.totals);
    failures = outcome.failures;
    for (const { path: p, error } of outcome.errors) {
      console.error(`domflax: failed ${path.relative(process.cwd(), p) || p}: ${error}`);
    }
    for (const dest of [...outcome.wrote].sort()) {
      console.log(`domflax: wrote ${path.relative(process.cwd(), dest) || dest}`);
    }
  } else {
    failures += runInline(files, options, inputRoot, plan, totals);
  }

  // Always tell the user what happened — never exit silently.
  if (options.dryRun) {
    console.log('\ndomflax: dry run — no files were written.');
  } else if (totals.changed === 0) {
    console.log(
      `\ndomflax: processed ${totals.files} file${totals.files === 1 ? '' : 's'} — nothing to optimize (0 changed).`,
    );
  } else {
    console.log(
      `\ndomflax: optimized ${totals.changed} of ${totals.files} file${totals.files === 1 ? '' : 's'} ` +
        `(${totals.nodesRemoved} nodes removed, ${totals.classesSaved} classes saved, ${totals.bytesSaved} bytes saved).`,
    );
  }

  if (options.report) printReport(totals);

  return { exitCode: failures > 0 ? 1 : 0 };
}

/**
 * CLI entry point. Parses argv, optionally launches the wizard (TTY + no positionals only), and
 * executes. Sets `process.exitCode`; never throws.
 */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  let options: CliOptions;
  try {
    options = parseInvocation(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  // Treat a CI environment as non-interactive even if it reports a TTY, so the wizard can never
  // block a pipeline (CI runners commonly set `CI`; cover the usual vendor flags too).
  const inCi =
    !!process.env.CI ||
    !!process.env.CONTINUOUS_INTEGRATION ||
    !!process.env.GITHUB_ACTIONS ||
    !!process.env.GITLAB_CI ||
    !!process.env.BUILDKITE ||
    !!process.env.TF_BUILD;
  const isTty = process.stdout.isTTY === true && !inCi;
  if (shouldPrompt(options, isTty)) {
    const wizardResult = await runWizard(options);
    if (wizardResult === WIZARD_CANCELLED) {
      process.exitCode = 0;
      return;
    }
    options = wizardResult;
  }

  if (options.paths.length === 0) {
    console.error('domflax: no input paths given (and not an interactive terminal).');
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  try {
    const result = await execute(options);
    process.exitCode = result.exitCode;
  } catch (err) {
    console.error(`domflax: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

// NOTE: no self-invocation here. `main()` is invoked exactly once by the published
// bin wrapper (packages/domflax/src/cli.ts). Auto-running on import caused the CLI
// to execute twice when this module is bundled into the `domflax` bin.
