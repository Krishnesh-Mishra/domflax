/**
 * @domflax/cli — the command-line entry point.
 *
 * TYPED STUB. Argument parsing is real (Node built-ins only: `node:util`'s `parseArgs` and
 * `node:fs`); the actual optimization run is wired to {@link import('@domflax/core').Pipeline}
 * in a later stage and currently throws NotImplemented.
 *
 * Future deps (NOT added to package.json while this is a stub): none — the CLI stays
 * dependency-free apart from @domflax/core. Frontend/backend/resolver selection lands when the
 * orchestrator package exists.
 */

import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';

import type { FileKind, PipelineConfig, SafetyLevel } from '@domflax/core';

/** Provider/resolver identifiers the CLI knows how to wire (resolver lands in a later stage). */
export type ProviderId = 'tailwind' | 'css';

/** Parsed, validated invocation — the shape the (future) orchestrator consumes. */
export interface CliInvocation {
  /** Positional source file to optimize. */
  readonly path: string;
  /** Style provider to resolve author tokens against. */
  readonly provider: ProviderId;
  /** Optional path to a source CSS file feeding the resolver. */
  readonly css: string | null;
  /** When true, compute edits but never write them back to disk. */
  readonly dryRun: boolean;
  /** When true, emit a machine-readable report instead of (or alongside) rewriting. */
  readonly report: boolean;
}

/** Outcome of {@link run}: a process exit code plus the lines that were printed. */
export interface RunResult {
  readonly exitCode: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

/** Default safety level the CLI requests of the pipeline (D-level: 2 = default). */
export const DEFAULT_SAFETY: SafetyLevel = 2;

const DEFAULT_PROVIDER: ProviderId = 'tailwind';

function isProviderId(value: string): value is ProviderId {
  return value === 'tailwind' || value === 'css';
}

/**
 * Maps a file path to the frontend {@link FileKind}. Real, trivial logic — the heavy parse lives
 * downstream. Unknown extensions map to `'unknown'` so the orchestrator can reject them.
 */
export function fileKindOf(path: string): FileKind {
  const lower = path.toLowerCase();
  if (lower.endsWith('.tsx')) return 'tsx';
  if (lower.endsWith('.jsx')) return 'jsx';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  return 'unknown';
}

/** Builds the pipeline config the CLI would hand to the orchestrator. */
export function toPipelineConfig(inv: CliInvocation): PipelineConfig {
  return {
    safety: DEFAULT_SAFETY,
    emitSourceMap: !inv.dryRun,
  };
}

/**
 * Parses argv (excluding `node` + script path) into a validated {@link CliInvocation}.
 * Throws on malformed flags or a missing positional path.
 */
export function parseInvocation(argv: readonly string[]): CliInvocation {
  const { values, positionals } = parseArgs({
    args: argv as string[],
    allowPositionals: true,
    options: {
      provider: { type: 'string' },
      css: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      report: { type: 'boolean', default: false },
    },
  });

  const path = positionals[0];
  if (path === undefined) {
    throw new Error('domflax-cli: missing required <path> positional argument');
  }

  const provider = values.provider ?? DEFAULT_PROVIDER;
  if (!isProviderId(provider)) {
    throw new Error(`domflax-cli: unknown --provider "${provider}" (expected "tailwind" or "css")`);
  }

  return {
    path,
    provider,
    css: values.css ?? null,
    dryRun: values['dry-run'] === true,
    report: values.report === true,
  };
}

const USAGE = [
  'Usage: domflax-cli <path> [options]',
  '',
  'Options:',
  '  --provider <tailwind|css>  Style provider to resolve tokens (default: tailwind)',
  '  --css <path>               Source CSS file feeding the resolver',
  '  --dry-run                  Compute edits without writing them back',
  '  --report                   Emit a machine-readable report',
].join('\n');

/**
 * CLI entry point. Parses argv, validates the input, and prints a not-yet-implemented notice.
 * Returns a {@link RunResult} so callers/tests can assert without intercepting the real streams;
 * the thin `bin` wrapper below maps it onto `console` + `process.exitCode`.
 */
export function run(argv: readonly string[]): RunResult {
  const stdout: string[] = [];
  const stderr: string[] = [];

  let inv: CliInvocation;
  try {
    inv = parseInvocation(argv);
  } catch (err) {
    stderr.push(err instanceof Error ? err.message : String(err));
    stderr.push(USAGE);
    return { exitCode: 2, stdout, stderr };
  }

  if (!existsSync(inv.path)) {
    stderr.push(`domflax-cli: no such file: ${inv.path}`);
    return { exitCode: 1, stdout, stderr };
  }

  const kind = fileKindOf(inv.path);
  if (kind === 'unknown') {
    stderr.push(`domflax-cli: unsupported file kind for ${inv.path} (expected .jsx/.tsx/.html)`);
    return { exitCode: 1, stdout, stderr };
  }

  stdout.push(`domflax-cli (stub)`);
  stdout.push(`  path:     ${inv.path} [${kind}]`);
  stdout.push(`  provider: ${inv.provider}`);
  stdout.push(`  css:      ${inv.css ?? '(none)'}`);
  stdout.push(`  dry-run:  ${inv.dryRun}`);
  stdout.push(`  report:   ${inv.report}`);
  stdout.push('');
  stdout.push('NotImplemented: the optimization pipeline lands in a later stage.');

  return { exitCode: 0, stdout, stderr };
}

/**
 * Executes {@link run} and binds its result to the real process: writes the captured lines to the
 * corresponding streams and sets `process.exitCode`. The `bin` shim calls this.
 */
export function main(argv: readonly string[] = process.argv.slice(2)): void {
  const result = run(argv);
  for (const line of result.stdout) console.log(line);
  for (const line of result.stderr) console.error(line);
  process.exitCode = result.exitCode;
}

// Auto-run when invoked as the bin (CJS/ESM both expose this entry as the program).
main();
