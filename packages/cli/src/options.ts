/**
 * @domflax/cli — invocation parsing & the shared options object.
 *
 * Both the flag parser ({@link parseInvocation}) and the interactive wizard build the SAME
 * {@link CliOptions} object (DESIGN-DECISIONS Q17), so the rest of the CLI is agnostic to how the
 * user expressed their intent.
 */

import { parseArgs } from 'node:util';

import type { SafetyLevel } from '@domflax/core';

/** How class names resolve to computed styles. */
export type ProviderOption = 'auto' | 'tailwind' | 'custom';

/** The fully-resolved request the CLI executes — produced by flags OR the wizard. */
export interface CliOptions {
  /** Positional sources: folders (recursive), globs, or individual files. */
  readonly paths: readonly string[];
  /** Output directory (`--out`); `null` ⇒ default `./domflax-out` (unless overwriting source). */
  readonly out: string | null;
  /** Style provider to resolve author tokens against. */
  readonly provider: ProviderOption;
  /** Stylesheet files feeding the custom-CSS resolver (`--css`). */
  readonly css: readonly string[];
  /** Compute edits + print per-file diffs but write nothing. */
  readonly dryRun: boolean;
  /** Print a summary (files, nodes removed, classes saved, bytes saved). */
  readonly report: boolean;
  /** Print PER-FILE optimization stats (nodes/classes/bytes for every changed file). */
  readonly details: boolean;
  /** Permit overwriting source in place (still gated on a clean git tree). */
  readonly dangerouslyOverwriteSource: boolean;
  /** Skip the clean-git-tree gate guarding `--dangerously-overwrite-source`. */
  readonly noGitCheck: boolean;
  /** Whether the interactive wizard may launch (false for `--no-interactive`/`--yes`). */
  readonly interactive: boolean;
  /** Pass names to run; `null` ⇒ every built-in pattern (the flag path never narrows). */
  readonly passes: readonly string[] | null;
  /** Optimization aggressiveness handed to the pass manager (0 lint … 3 aggressive). */
  readonly safety: SafetyLevel;
  /** Root to resolve the Tailwind/postcss engines from; `null` ⇒ `process.cwd()`. */
  readonly projectRoot: string | null;
  /**
   * Memory budget in MB (`--max-memory`) — caps BOTH the worker pool's RAM AND its parallelism
   * (fewer MB ⇒ fewer workers ⇒ slower but never OOM). `null` ⇒ default ≈ 70% of free RAM.
   */
  readonly maxMemory: number | null;
  /** Hard cap on worker count (`--concurrency`), still clamped down by the memory budget; `null` ⇒ auto. */
  readonly concurrency: number | null;
}

/** The CLI default optimization safety level (D-level 2 = default). */
export const DEFAULT_SAFETY: SafetyLevel = 2;

const DEFAULT_PROVIDER: ProviderOption = 'auto';

function isProvider(value: string): value is ProviderOption {
  return value === 'auto' || value === 'tailwind' || value === 'custom';
}

function toSafety(raw: string | undefined): SafetyLevel {
  if (raw === undefined) return DEFAULT_SAFETY;
  const n = Number(raw);
  if (n === 0 || n === 1 || n === 2 || n === 3) return n;
  throw new Error(`domflax: invalid --safety "${raw}" (expected 0, 1, 2 or 3)`);
}

/** Parse a `--max-memory`/`--concurrency` value into a positive integer, or throw. `null` when absent. */
function toPositiveInt(raw: string | undefined, flag: string): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`domflax: invalid ${flag} "${raw}" (expected a positive integer)`);
  }
  return n;
}

/**
 * Parse argv (excluding `node` + script path) into a validated {@link CliOptions}. A missing
 * positional is NOT an error here — a no-args TTY run is handled upstream by launching the wizard.
 */
export function parseInvocation(argv: readonly string[]): CliOptions {
  const { values, positionals } = parseArgs({
    args: argv as string[],
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      provider: { type: 'string' },
      css: { type: 'string', multiple: true },
      'dry-run': { type: 'boolean', default: false },
      report: { type: 'boolean', default: false },
      details: { type: 'boolean', default: false },
      'dangerously-overwrite-source': { type: 'boolean', default: false },
      'no-git-check': { type: 'boolean', default: false },
      'no-interactive': { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      safety: { type: 'string' },
      'project-root': { type: 'string' },
      'max-memory': { type: 'string' },
      concurrency: { type: 'string' },
    },
  });

  const provider = values.provider ?? DEFAULT_PROVIDER;
  if (!isProvider(provider)) {
    throw new Error(`domflax: unknown --provider "${provider}" (expected auto|tailwind|custom)`);
  }

  return {
    paths: positionals,
    out: values.out ?? null,
    provider,
    css: values.css ?? [],
    dryRun: values['dry-run'] === true,
    report: values.report === true,
    details: values.details === true,
    dangerouslyOverwriteSource: values['dangerously-overwrite-source'] === true,
    noGitCheck: values['no-git-check'] === true,
    interactive: values['no-interactive'] !== true && values.yes !== true,
    passes: null,
    safety: toSafety(values.safety),
    projectRoot: values['project-root'] ?? null,
    maxMemory: toPositiveInt(values['max-memory'], '--max-memory'),
    concurrency: toPositiveInt(values.concurrency, '--concurrency'),
  };
}

/** True iff the interactive wizard should launch: a TTY, no positionals, and not opted out. */
export function shouldPrompt(options: CliOptions, isTty: boolean): boolean {
  return isTty && options.interactive && options.paths.length === 0;
}

export const USAGE: string = [
  'Usage: domflax [paths...] [options]',
  '',
  'Optimizes .jsx/.tsx/.html files (flatten redundant wrappers + compress class sets).',
  'Source is READ-ONLY by default — output goes to --out or ./domflax-out.',
  '',
  'Arguments:',
  '  paths                          folders (recursive), globs, or files',
  '',
  'Options:',
  '  --out <dir>                    write optimized files here, mirroring structure',
  '  --provider <auto|tailwind|custom>  style resolver (default: auto)',
  '  --css <file...>                stylesheets feeding the custom-CSS provider',
  '  --dry-run                      print per-file diffs; write nothing',
  '  --report                       print a summary of what changed',
  '  --details                      print per-file optimization stats (nodes/classes/bytes)',
  '  --dangerously-overwrite-source overwrite source in place (needs a clean git tree)',
  '  --no-git-check                 skip the clean-git-tree gate',
  '  --safety <0|1|2|3>             optimization aggressiveness (default: 2)',
  '  --max-memory <MB>              memory budget; caps pool RAM AND parallelism (default: ~70% free RAM)',
  '  --concurrency <N>              max parallel workers (still clamped by --max-memory)',
  '  --yes, --no-interactive        never launch the wizard (CI-safe)',
  '',
  'Many files are processed across CPU cores by a memory-bounded worker pool; small jobs run inline.',
  'With no paths in an interactive terminal, a guided wizard launches.',
].join('\n');
