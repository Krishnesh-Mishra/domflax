/**
 * domflax — webpack loader ↔ plugin AUDIT bridge.
 *
 * Mirrors the summary bridge in {@link ./summary}: the webpack loader and the plugin ship as
 * SEPARATE bundles, so audit totals are stashed on the webpack `compilation` object under
 * GLOBAL-REGISTRY symbols (`Symbol.for`, shared process-wide). The loader accumulates per-module
 * would-be savings ({@link accumulateAuditOnCompilation}); the plugin's `done` hook prints the
 * boxed audit report once ({@link printCompilationAudit}).
 */

import { emptyAuditTotals, recordAudit, renderAudit } from '@domflax/cli/audit';
import type { AuditTotals } from '@domflax/cli/audit';

import type { FileStatDelta } from '../engine/summary';

/** Global-registry keys — identical string ⇒ identical symbol across the separately-bundled files. */
const AUDIT_TOTALS_KEY = Symbol.for('domflax.auditTotals');
const AUDIT_PRINTED_KEY = Symbol.for('domflax.auditPrinted');

/** Accumulate one module's would-be delta onto a webpack `compilation` (called from the loader). */
export function accumulateAuditOnCompilation(compilation: unknown, id: string, stats: FileStatDelta): void {
  if (compilation === null || typeof compilation !== 'object') return;
  const bag = compilation as Record<symbol, unknown>;
  let totals = bag[AUDIT_TOTALS_KEY] as AuditTotals | undefined;
  if (!totals) {
    totals = emptyAuditTotals();
    bag[AUDIT_TOTALS_KEY] = totals;
  }
  // FileStatDelta structurally satisfies AuditFileStats (nodesBefore/bytesBefore + the savings).
  recordAudit(totals, id, stats);
}

/**
 * Print the audit box stashed on a `compilation` exactly once (called from the plugin's `done`
 * hook). Silent when nothing was stashed. The once-latch guards a double-tap.
 */
export function printCompilationAudit(compilation: unknown): void {
  if (compilation === null || typeof compilation !== 'object') return;
  const bag = compilation as Record<symbol, unknown>;
  if (bag[AUDIT_PRINTED_KEY]) return;
  bag[AUDIT_PRINTED_KEY] = true;
  const totals = bag[AUDIT_TOTALS_KEY] as AuditTotals | undefined;
  if (totals && totals.files > 0) process.stdout.write(renderAudit(totals));
}
