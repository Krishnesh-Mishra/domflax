/**
 * @domflax/cli — invocation parsing & the shared options object.
 *
 * Both the flag parser ({@link parseInvocation}) and the interactive wizard build the SAME
 * {@link CliOptions} object (DESIGN-DECISIONS Q17), so the rest of the CLI is agnostic to how the
 * user expressed their intent.
 */

import { parseArgs } from 'node:util';

import type { SafetyLevel } from '@domflax/core';

import type { DomflaxConfig } from './config-file';

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
  /**
   * AUDIT mode (`--audit`): like dry-run but prints a 0–100 DOM-efficiency SCORE box (aggregate
   * potential savings + worst files) instead of diffs. Writes NOTHING and ignores `--out`.
   */
  readonly audit: boolean;
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

/** Resolve the safety level: explicit flag > config file > {@link DEFAULT_SAFETY}. Validates both. */
function toSafety(raw: string | undefined, fromConfig: number | undefined): SafetyLevel {
  if (raw !== undefined) {
    const n = Number(raw);
    if (n === 0 || n === 1 || n === 2 || n === 3) return n;
    throw new Error(`domflax: invalid --safety "${raw}" (expected 0, 1, 2 or 3)`);
  }
  if (fromConfig !== undefined) {
    if (fromConfig === 0 || fromConfig === 1 || fromConfig === 2 || fromConfig === 3) return fromConfig;
    throw new Error(`domflax: invalid "safety" in config file: ${fromConfig} (expected 0, 1, 2 or 3)`);
  }
  return DEFAULT_SAFETY;
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

/** Validate a positive-integer value coming from the config file. `null` when absent. */
function configPositiveInt(value: number | undefined, key: string): number | null {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`domflax: invalid "${key}" in config file: ${value} (expected a positive integer)`);
  }
  return value;
}

/**
 * Parse argv (excluding `node` + script path) into a validated {@link CliOptions}. A missing
 * positional is NOT an error here — a no-args TTY run is handled upstream by launching the wizard.
 *
 * `fileConfig` (from a discovered `domflax.config.*`) is merged UNDERNEATH the flags: every value
 * an explicit flag provides wins; anything the flags leave unset falls back to the file, then to
 * the built-in default. The danger flags (`--dangerously-overwrite-source`, `--no-git-check`) and
 * the interactivity opt-out are deliberately NOT configurable from a file.
 */
export function parseInvocation(argv: readonly string[], fileConfig: DomflaxConfig = {}): CliOptions {
  const { values, positionals } = parseArgs({
    args: argv as string[],
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      provider: { type: 'string' },
      css: { type: 'string', multiple: true },
      'dry-run': { type: 'boolean' },
      audit: { type: 'boolean' },
      report: { type: 'boolean' },
      details: { type: 'boolean' },
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

  const provider = values.provider ?? fileConfig.provider ?? DEFAULT_PROVIDER;
  if (!isProvider(provider)) {
    throw values.provider !== undefined
      ? new Error(`domflax: unknown --provider "${provider}" (expected auto|tailwind|custom)`)
      : new Error(`domflax: unknown "provider" in config file: "${provider}" (expected auto|tailwind|custom)`);
  }

  // `css` (CLI spelling) and `cssFiles` (plugin spelling) are aliases in the shared config.
  const cssFromConfig = fileConfig.css ?? fileConfig.cssFiles;

  return {
    paths: positionals,
    out: values.out ?? fileConfig.out ?? null,
    provider,
    css: values.css ?? (cssFromConfig !== undefined ? [...cssFromConfig] : []),
    dryRun: (values['dry-run'] ?? fileConfig.dryRun) === true,
    audit: (values.audit ?? fileConfig.audit) === true,
    report: (values.report ?? fileConfig.report) === true,
    details: (values.details ?? fileConfig.details) === true,
    dangerouslyOverwriteSource: values['dangerously-overwrite-source'] === true,
    noGitCheck: values['no-git-check'] === true,
    interactive: values['no-interactive'] !== true && values.yes !== true,
    passes: fileConfig.passes !== undefined ? [...fileConfig.passes] : null,
    safety: toSafety(values.safety, fileConfig.safety),
    projectRoot: values['project-root'] ?? fileConfig.projectRoot ?? null,
    maxMemory: toPositiveInt(values['max-memory'], '--max-memory') ?? configPositiveInt(fileConfig.maxMemory, 'maxMemory'),
    concurrency: toPositiveInt(values.concurrency, '--concurrency') ?? configPositiveInt(fileConfig.concurrency, 'concurrency'),
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
  '  --audit                        analyze only: print a 0-100 DOM-efficiency score; writes NOTHING',
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
  '',
  'Options may also come from a domflax.config.{js,mjs,cjs,json} file (nearest file, searched upward',
  'from --project-root or the cwd). Explicit flags always override the config file.',
].join('\n');
