/**
 * domflax — AUDIT / SCORE mode (shared by the CLI's `--audit` and the plugins' `audit: true`).
 *
 * Audit runs the normal transform pipeline but WRITES NOTHING: per-file would-be savings are
 * accumulated into an {@link AuditTotals}, condensed into a 0–100 DOM-efficiency score
 * ({@link computeScore}) and printed as one boxed report ({@link renderAudit}) listing the
 * aggregate potential plus the top {@link AUDIT_TOP_FILES} worst files by savable bytes.
 *
 * ## The score formula
 *
 * ```
 * byteRatio = bytesSavable   / max(1, bytesTotal)    // savable bytes per total input bytes
 * nodeRatio = nodesRemovable / max(1, nodesTotal)    // removable nodes per total elements
 * score     = round(100 × (1 − byteRatio) × (1 − nodeRatio)),  clamped to [0, 100]
 * ```
 *
 * 100 means nothing to improve. The two waste ratios multiply so each dimension (markup weight,
 * DOM depth) independently drags the score down — e.g. 10% savable bytes AND 10% removable nodes
 * ⇒ 100 × 0.9 × 0.9 = 81.
 */

import type { FileStats } from './transform';

/** How many "worst files" the audit report lists. */
export const AUDIT_TOP_FILES = 5;

/**
 * Per-file numbers the audit needs: the BEFORE totals (denominators) plus the would-be savings.
 * Structurally satisfied by the plugins' `FileStatDelta` and derivable from the CLI's
 * {@link FileStats} via {@link auditStatsFromFile}.
 */
export interface AuditFileStats {
  /** Total IR/DOM element nodes in the file before optimization. */
  readonly nodesBefore: number;
  /** Nodes a real run would remove (provably-safe flattens). */
  readonly nodesRemoved: number;
  /** Class tokens a real run would eliminate (semantic compression). */
  readonly classesSaved: number;
  /** UTF-8 byte length of the file before optimization. */
  readonly bytesBefore: number;
  /** Bytes a real run would save (may be ≤ 0; audit clamps at 0). */
  readonly bytesSaved: number;
}

/** One entry in the "top files by savable bytes" list. */
export interface AuditWorstFile {
  /** File identifier (the CLI uses input-root-relative paths; plugins use module ids). */
  readonly id: string;
  readonly bytesSavable: number;
  readonly nodesRemovable: number;
  readonly classesCompressible: number;
}

/** Aggregate audit accumulator across a whole run/build. */
export interface AuditTotals {
  /** Files analyzed (every supported file, changed or not). */
  files: number;
  /** Files with ANY potential saving (nodes, classes or bytes). */
  filesImprovable: number;
  /** Total element nodes across all analyzed files (score denominator). */
  nodesTotal: number;
  /** Total removable nodes. */
  nodesRemovable: number;
  /** Total compressible class tokens. */
  classesCompressible: number;
  /** Total input bytes across all analyzed files (score denominator). */
  bytesTotal: number;
  /** Total savable bytes (per-file clamped at ≥ 0). */
  bytesSavable: number;
  /** Worst files, sorted by savable bytes (desc), capped at {@link AUDIT_TOP_FILES}. */
  worst: AuditWorstFile[];
}

/** A fresh, zeroed {@link AuditTotals}. */
export function emptyAuditTotals(): AuditTotals {
  return {
    files: 0,
    filesImprovable: 0,
    nodesTotal: 0,
    nodesRemovable: 0,
    classesCompressible: 0,
    bytesTotal: 0,
    bytesSavable: 0,
    worst: [],
  };
}

/** Reset an {@link AuditTotals} in place (watch/serve rebuilds get a fresh audit per build). */
export function resetAuditTotals(t: AuditTotals): void {
  t.files = 0;
  t.filesImprovable = 0;
  t.nodesTotal = 0;
  t.nodesRemovable = 0;
  t.classesCompressible = 0;
  t.bytesTotal = 0;
  t.bytesSavable = 0;
  t.worst = [];
}

/** Adapt the CLI's full per-file {@link FileStats} to the audit shape. */
export function auditStatsFromFile(stats: FileStats): AuditFileStats {
  return {
    nodesBefore: stats.nodesIn,
    nodesRemoved: stats.nodesRemoved,
    classesSaved: stats.classesSaved,
    bytesBefore: stats.bytesBefore,
    bytesSaved: stats.bytesSaved,
  };
}

/**
 * Fold one analyzed file into the running totals. Every file counts toward the denominators
 * (`nodesTotal`/`bytesTotal`); only files with a potential saving count as improvable and compete
 * for the worst-files list (ordered by savable bytes desc, ties broken by id for determinism).
 */
export function recordAudit(t: AuditTotals, id: string, s: AuditFileStats): void {
  t.files += 1;
  t.nodesTotal += s.nodesBefore;
  t.bytesTotal += s.bytesBefore;

  const bytesSavable = Math.max(0, s.bytesSaved);
  if (bytesSavable === 0 && s.nodesRemoved === 0 && s.classesSaved === 0) return;

  t.filesImprovable += 1;
  t.nodesRemovable += s.nodesRemoved;
  t.classesCompressible += s.classesSaved;
  t.bytesSavable += bytesSavable;

  t.worst.push({
    id,
    bytesSavable,
    nodesRemovable: s.nodesRemoved,
    classesCompressible: s.classesSaved,
  });
  t.worst.sort((a, b) => b.bytesSavable - a.bytesSavable || a.id.localeCompare(b.id));
  if (t.worst.length > AUDIT_TOP_FILES) t.worst.length = AUDIT_TOP_FILES;
}

/**
 * The 0–100 DOM-efficiency score.
 *
 * ```
 * byteRatio = bytesSavable   / max(1, bytesTotal)
 * nodeRatio = nodesRemovable / max(1, nodesTotal)
 * score     = round(100 × (1 − byteRatio) × (1 − nodeRatio))   // clamped to [0, 100]
 * ```
 *
 * 100 ⇔ nothing to improve; each waste dimension (savable-bytes-per-total-bytes and
 * removable-nodes-per-total-elements) scales the score down multiplicatively.
 */
export function computeScore(t: AuditTotals): number {
  const byteRatio = Math.min(1, t.bytesSavable / Math.max(1, t.bytesTotal));
  const nodeRatio = Math.min(1, t.nodesRemovable / Math.max(1, t.nodesTotal));
  const score = Math.round(100 * (1 - byteRatio) * (1 - nodeRatio));
  return Math.max(0, Math.min(100, score));
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Formatting
 * ────────────────────────────────────────────────────────────────────────── */

const BYTE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

/** Human byte size: `< 1 KiB` stays `B`, otherwise KB/MB/GB/TB with one decimal (1024-based). */
export function formatAuditBytes(n: number): string {
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
export function formatAuditCount(n: number): string {
  return Math.trunc(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Width of the label column inside the audit box. */
const LABEL_WIDTH = 22;
/** The horizontal rule inside the box. */
const RULE = `  ${'─'.repeat(44)}`;

function row(label: string, value: string): string {
  return `   ${label.padEnd(LABEL_WIDTH)}${value}`;
}

/**
 * Render the boxed audit report: the score, the aggregate potential savings, and the top
 * {@link AUDIT_TOP_FILES} worst files by savable bytes. Callers typically print this once at the
 * end of a run/build (audit mode never writes files, so this box IS the whole output).
 */
export function renderAudit(t: AuditTotals): string {
  const lines = [
    '',
    '  ▲ domflax audit',
    RULE,
    row('DOM efficiency score', `${computeScore(t)} / 100`),
    RULE,
    row('files analyzed', formatAuditCount(t.files)),
    row('files improvable', formatAuditCount(t.filesImprovable)),
    row('nodes removable', `${formatAuditCount(t.nodesRemovable)} of ${formatAuditCount(t.nodesTotal)}`),
    row('classes compressible', formatAuditCount(t.classesCompressible)),
    row('bytes savable', `${formatAuditBytes(t.bytesSavable)} of ${formatAuditBytes(t.bytesTotal)}`),
  ];
  if (t.worst.length > 0) {
    lines.push(RULE, '   top files by savable bytes');
    t.worst.forEach((w, i) => {
      lines.push(
        `    ${i + 1}. ${w.id} — ${formatAuditBytes(w.bytesSavable)} ` +
          `(${formatAuditCount(w.nodesRemovable)} nodes, ${formatAuditCount(w.classesCompressible)} classes)`,
      );
    });
  }
  lines.push(RULE, '');
  return lines.join('\n');
}
