/**
 * domflax — build-end optimization SUMMARY.
 *
 * A tiny, dependency-free formatter shared by the Vite and webpack/Next adapters. Each adapter
 * accumulates {@link FileStatDelta} numbers across the build into a {@link Totals}, then prints ONE
 * boxed {@link renderSummary} block at build end — so the user sees the aggregate payoff without any
 * per-file spam in between.
 *
 * ```
 *   ▲ domflax
 *   ────────────────────────────────
 *    files optimized     42
 *    DOM nodes removed   318
 *    classes compressed  1,204
 *    size saved          18.7 KB
 *   ────────────────────────────────
 * ```
 */

/** Per-file optimization delta (from a single {@link Domflax.transform}). */
export interface FileStatDelta {
  /** Total IR/DOM element nodes in the file BEFORE optimization (audit-score denominator). */
  readonly nodesBefore: number;
  /** DOM/IR nodes removed by provably-safe flattens. */
  readonly nodesRemoved: number;
  /** Class tokens eliminated by semantic compression. */
  readonly classesSaved: number;
  /** UTF-8 byte length of the file BEFORE optimization (audit-score denominator). */
  readonly bytesBefore: number;
  /** Bytes saved = original byte length − output byte length (may be negative in edge cases). */
  readonly bytesSaved: number;
}

/** All-zero delta, for unsupported / unchanged files. */
export function zeroStats(): FileStatDelta {
  return { nodesBefore: 0, nodesRemoved: 0, classesSaved: 0, bytesBefore: 0, bytesSaved: 0 };
}

/** Aggregate accumulator across a whole build. `files` counts only files that actually changed. */
export interface Totals {
  files: number;
  nodesRemoved: number;
  classesCompressed: number;
  bytesSaved: number;
}

/** A fresh, zeroed {@link Totals}. */
export function emptyTotals(): Totals {
  return { files: 0, nodesRemoved: 0, classesCompressed: 0, bytesSaved: 0 };
}

/** Reset a {@link Totals} in place (used to clear per rebuild in watch/serve mode). */
export function resetTotals(t: Totals): void {
  t.files = 0;
  t.nodesRemoved = 0;
  t.classesCompressed = 0;
  t.bytesSaved = 0;
}

/** Fold one file's delta into the running totals. Only `changed` files count toward `files`. */
export function addStats(t: Totals, s: FileStatDelta, changed: boolean): void {
  if (!changed) return;
  t.files += 1;
  t.nodesRemoved += s.nodesRemoved;
  t.classesCompressed += s.classesSaved;
  t.bytesSaved += s.bytesSaved;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Formatting
 * ────────────────────────────────────────────────────────────────────────── */

const BYTE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

/** Human byte size: `< 1 KiB` stays `B`, otherwise KB/MB/GB/TB with one decimal (1024-based). */
export function formatBytes(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1024) return `${n} B`;
  let value = n / 1024;
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

/** Integer with thousands separators, e.g. `1204` → `1,204` (locale-independent). */
export function formatCount(n: number): string {
  return Math.trunc(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Width of the label column (values align to this offset within the 3-space row indent). */
const LABEL_WIDTH = 20;
/** The horizontal rule inside the box. */
const RULE = `  ${'─'.repeat(32)}`;

function row(label: string, value: string): string {
  return `   ${label.padEnd(LABEL_WIDTH)}${value}`;
}

/**
 * Render the boxed build-end summary. Callers should only invoke this when `totals.files > 0`
 * (i.e. at least one file changed) so a no-op build stays silent.
 */
export function renderSummary(totals: Totals): string {
  return [
    '',
    '  ▲ domflax',
    RULE,
    row('files optimized', formatCount(totals.files)),
    row('DOM nodes removed', formatCount(totals.nodesRemoved)),
    row('classes compressed', formatCount(totals.classesCompressed)),
    row('size saved', formatBytes(totals.bytesSaved)),
    RULE,
    '',
  ].join('\n');
}

/* ────────────────────────────────────────────────────────────────────────── *
 * webpack loader ↔ plugin bridge
 *
 * The webpack loader (`webpack-loader.cjs`) and the plugin (`index.cjs`) ship as SEPARATE bundles,
 * so a module-level accumulator would not be shared between them. Instead the loader stashes the
 * running {@link Totals} directly on the webpack `compilation` object under a GLOBAL-REGISTRY symbol
 * (`Symbol.for`, shared process-wide across both bundles); the plugin reads the same key from the
 * compilation in its `done` hook. A fresh compilation per (re)build gives per-build totals for free.
 * ────────────────────────────────────────────────────────────────────────── */

/** Global-registry keys — identical string ⇒ identical symbol across the separately-bundled files. */
const TOTALS_KEY = Symbol.for('domflax.buildTotals');
const PRINTED_KEY = Symbol.for('domflax.summaryPrinted');

/** Accumulate one file's delta onto a webpack `compilation` (called from the loader). Defensive. */
export function accumulateOnCompilation(compilation: unknown, stats: FileStatDelta, changed: boolean): void {
  if (compilation === null || typeof compilation !== 'object') return;
  const bag = compilation as Record<symbol, unknown>;
  let totals = bag[TOTALS_KEY] as Totals | undefined;
  if (!totals) {
    totals = emptyTotals();
    bag[TOTALS_KEY] = totals;
  }
  addStats(totals, stats, changed);
}

/**
 * Print the summary stashed on a `compilation` exactly once (called from the plugin's `done` hook).
 * Silent when nothing was stashed or nothing changed. The once-latch guards a double-tap.
 */
export function printCompilationSummary(compilation: unknown): void {
  if (compilation === null || typeof compilation !== 'object') return;
  const bag = compilation as Record<symbol, unknown>;
  if (bag[PRINTED_KEY]) return;
  bag[PRINTED_KEY] = true;
  const totals = bag[TOTALS_KEY] as Totals | undefined;
  if (totals && totals.files > 0) process.stdout.write(renderSummary(totals));
}
