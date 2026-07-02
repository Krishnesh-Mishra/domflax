/**
 * domflax — the Vite build adapter.
 *
 * Returns a real Vite `Plugin` (`enforce: 'pre'`) whose `transform` runs the domflax engine on
 * `.jsx`/`.tsx` modules. In AUDIT mode (`audit: true`, inline or from `domflax.config.*`) every
 * module passes through UNCHANGED while would-be savings accumulate; build end prints the boxed
 * 0-100 DOM-efficiency score instead of the optimization summary.
 */

import { emptyAuditTotals, recordAudit, renderAudit, resetAuditTotals } from '@domflax/cli/audit';
import type { AuditTotals } from '@domflax/cli/audit';

import { createDomflax } from '../engine/engine';
import type { DomflaxTransformResult } from '../engine/engine';
import { isSupported, withConfigFile } from '../engine/options';
import type { DomflaxOptions } from '../engine/options';
import { addStats, emptyTotals, renderSummary, resetTotals } from '../engine/summary';
import type { Totals } from '../engine/summary';

/**
 * Minimal Vite-plugin shape. Declared locally so this adapter does NOT depend on `vite`'s types
 * (an optional, type-only peer). Structurally compatible with Vite's `Plugin` for the hooks domflax
 * uses: `enforce: 'pre'` runs domflax before Vite's JSX→`createElement` transform, and `transform`
 * is Vite's per-file source hook. Returning `null` is Vite's "no change" signal.
 */
export interface DomflaxVitePlugin {
  readonly name: string;
  readonly enforce: 'pre';
  /** Vite's per-file source hook. Fully synchronous and browser-free. */
  transform(code: string, id: string): DomflaxTransformResult | null;
  /** Vite build-start hook — resets the per-build summary accumulator (watch/serve safe). */
  buildStart(): void;
  /** Vite build-end hook — prints the aggregate {@link renderSummary} once (if anything changed). */
  buildEnd(): void;
  /** Vite close-bundle hook — prints the summary as a backstop if `buildEnd` did not fire. */
  closeBundle(): void;
}

/** Strip any bundler query suffix (e.g. `App.tsx?used`) for stable audit file ids. */
function cleanId(id: string): string {
  return id.split('?', 1)[0] ?? id;
}

/**
 * Vite adapter. Returns a real Vite `Plugin` (`enforce: 'pre'`) whose `transform` runs the domflax
 * engine on `.jsx`/`.tsx` modules — strips any bundler query suffix (e.g. `App.tsx?used`) before
 * matching, returns `{ code, map }` when the source changed, and `null` (Vite's unchanged signal)
 * for unchanged sources and for any non-jsx/tsx module.
 *
 * A `domflax.config.{js,mjs,cjs,json}` (nearest, upward from `projectRoot`/cwd) is merged UNDER the
 * inline options; pass `configFile: false` to disable discovery.
 *
 * @example
 * ```js
 * // vite.config.js
 * import domflax from 'domflax';
 * export default { plugins: [domflax.vite({ provider: 'tailwind' })] };
 * ```
 */
export function vite(options: DomflaxOptions = {}): DomflaxVitePlugin {
  // Merge the config file ONCE here, then hand the merged options (configFile already applied) to
  // the engine so discovery never runs twice.
  const merged = withConfigFile(options);
  const engine = createDomflax(merged);
  const audit = engine.options.audit;

  // Aggregate across every `transform` call in this plugin instance. `buildStart` resets it so
  // watch/serve rebuilds each get their own summary; a `printed` latch guards the double-fire of
  // `buildEnd` + `closeBundle`.
  const totals: Totals = emptyTotals();
  const auditTotals: AuditTotals = emptyAuditTotals();
  let printed = false;

  const printSummary = (): void => {
    if (printed) return;
    printed = true;
    if (audit) {
      if (auditTotals.files > 0) process.stdout.write(renderAudit(auditTotals));
      return;
    }
    if (totals.files > 0) process.stdout.write(renderSummary(totals));
  };

  return {
    name: 'domflax',
    enforce: 'pre',
    buildStart(): void {
      resetTotals(totals);
      resetAuditTotals(auditTotals);
      printed = false;
    },
    transform(code: string, id: string): DomflaxTransformResult | null {
      if (!isSupported(id, engine.options.include)) return null;
      const out = engine.transform(code, id);
      // AUDIT: transform NOTHING — pass the module through and only aggregate the would-be delta.
      if (audit) {
        recordAudit(auditTotals, cleanId(id), out.stats);
        return null;
      }
      const changed = out.code !== code;
      addStats(totals, out.stats, changed);
      // Signal "no change" to Vite when the source round-tripped unchanged.
      return changed ? out : null;
    },
    buildEnd(): void {
      printSummary();
    },
    closeBundle(): void {
      printSummary();
    },
  };
}
