import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AUDIT_TOP_FILES,
  auditStatsFromFile,
  computeScore,
  emptyAuditTotals,
  recordAudit,
  renderAudit,
} from '../src/audit';
import type { AuditFileStats } from '../src/audit';
import { execute } from '../src/index';
import { parseInvocation } from '../src/options';
import { runPool, type PoolPlan } from '../src/pool';
import { planWrites } from '../src/safety';

/** Shorthand audit-stats builder. */
const stats = (over: Partial<AuditFileStats> = {}): AuditFileStats => ({
  nodesBefore: 100,
  nodesRemoved: 0,
  classesSaved: 0,
  bytesBefore: 1000,
  bytesSaved: 0,
  ...over,
});

/* ───────────────────────── score formula ───────────────────────── */

describe('computeScore', () => {
  it('is 100 when nothing is improvable', () => {
    expect(computeScore(emptyAuditTotals())).toBe(100);
    const t = emptyAuditTotals();
    recordAudit(t, 'a.tsx', stats());
    expect(computeScore(t)).toBe(100);
  });

  it('follows round(100 × (1 − byteRatio) × (1 − nodeRatio))', () => {
    const t = emptyAuditTotals();
    // 100 savable of 1000 bytes (10%), 10 removable of 100 nodes (10%) → 100 × .9 × .9 = 81.
    recordAudit(t, 'a.tsx', stats({ bytesSaved: 100, nodesRemoved: 10 }));
    expect(computeScore(t)).toBe(81);
  });

  it('bottoms out at 0 when everything is savable', () => {
    const t = emptyAuditTotals();
    recordAudit(t, 'a.tsx', stats({ bytesSaved: 1000, nodesRemoved: 100 }));
    expect(computeScore(t)).toBe(0);
  });

  it('negative per-file byte deltas are clamped (never raise the score above files with 0)', () => {
    const t = emptyAuditTotals();
    recordAudit(t, 'a.tsx', stats({ bytesSaved: -50, nodesRemoved: 1 }));
    expect(t.bytesSavable).toBe(0);
    expect(t.nodesRemovable).toBe(1);
  });
});

/* ───────────────────────── accumulation + worst-files list ───────────────────────── */

describe('recordAudit', () => {
  it('counts every analyzed file toward the denominators, improvable ones separately', () => {
    const t = emptyAuditTotals();
    recordAudit(t, 'a.tsx', stats()); // nothing improvable
    recordAudit(t, 'b.tsx', stats({ bytesSaved: 40, classesSaved: 2 }));
    expect(t.files).toBe(2);
    expect(t.filesImprovable).toBe(1);
    expect(t.nodesTotal).toBe(200);
    expect(t.bytesTotal).toBe(2000);
    expect(t.classesCompressible).toBe(2);
    expect(t.bytesSavable).toBe(40);
  });

  it(`keeps the worst list ordered by savable bytes (desc) and capped at ${AUDIT_TOP_FILES}`, () => {
    const t = emptyAuditTotals();
    const sizes = [10, 70, 30, 90, 50, 20, 60];
    sizes.forEach((b, i) => recordAudit(t, `f${i}.tsx`, stats({ bytesSaved: b })));
    expect(t.worst).toHaveLength(AUDIT_TOP_FILES);
    expect(t.worst.map((w) => w.bytesSavable)).toEqual([90, 70, 60, 50, 30]);
    expect(t.worst[0]!.id).toBe('f3.tsx');
  });
});

/* ───────────────────────── the audit box ───────────────────────── */

describe('renderAudit', () => {
  it('prints the score, the totals and the ordered worst-files list', () => {
    const t = emptyAuditTotals();
    recordAudit(t, 'src/App.tsx', stats({ bytesSaved: 300, nodesRemoved: 12, classesSaved: 30 }));
    recordAudit(t, 'src/Nav.tsx', stats({ bytesSaved: 80, nodesRemoved: 3, classesSaved: 4 }));
    const out = renderAudit(t);

    expect(out).toContain('▲ domflax audit');
    expect(out).toContain('DOM efficiency score');
    expect(out).toContain(`${computeScore(t)} / 100`);
    expect(out).toContain('files analyzed');
    expect(out).toContain('files improvable');
    expect(out).toContain('nodes removable');
    expect(out).toContain('classes compressible');
    expect(out).toContain('bytes savable');
    expect(out).toContain('top files by savable bytes');
    // Worst-first ordering in the printed list.
    expect(out.indexOf('src/App.tsx')).toBeLessThan(out.indexOf('src/Nav.tsx'));
  });

  it('omits the top-files section when nothing is improvable', () => {
    const t = emptyAuditTotals();
    recordAudit(t, 'a.tsx', stats());
    expect(renderAudit(t)).not.toContain('top files');
  });
});

/* ───────────────────────── CLI end-to-end: --audit writes NOTHING ───────────────────────── */

describe('execute — audit mode', () => {
  let dir: string;
  let outDir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'domflax-audit-'));
    outDir = path.join(dir, '__out');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('prints the score box and writes NOTHING — even with --out', async () => {
    for (let i = 0; i < 3; i++) {
      writeFileSync(
        path.join(dir, `C${i}.tsx`),
        `export default function C${i}(){return (<div className="px-4 py-4 bg-white">{x}</div>);}\n`,
      );
    }
    const before = readdirSync(dir).sort();

    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await execute(parseInvocation([dir, '--audit', '--out', outDir, '--yes']));
    expect(result.exitCode).toBe(0);

    // NOTHING written: no out dir, inputs untouched, no per-file "wrote" lines.
    expect(existsSync(outDir)).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(before);
    const logged = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain('wrote');
    expect(logged).toContain('audit — no files were written.');

    // The boxed score report went to stdout.
    const boxed = write.mock.calls.map((c) => String(c[0])).join('');
    expect(boxed).toContain('▲ domflax audit');
    expect(boxed).toContain('DOM efficiency score');
    expect(boxed).toContain('files analyzed');
    expect(boxed).toContain('3');
    // The compressible px-4/py-4 pair yields real savable bytes → improvable files listed.
    expect(boxed).toContain('top files by savable bytes');
  });

  it('the worker POOL path audits large batches without writing anything', async () => {
    const files: string[] = [];
    for (let i = 0; i < 24; i++) {
      const f = path.join(dir, `C${i}.tsx`);
      writeFileSync(
        f,
        `export default function C${i}(){return (<div className="px-4 py-4 bg-white">{x}</div>);}\n`,
      );
      files.push(f);
    }
    const options = parseInvocation([dir, '--audit', '--out', outDir, '--yes']);
    const plan = planWrites(options, true);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const poolPlan: PoolPlan = { workers: 3, budgetMB: 2048, perWorkerCapMB: 512 };
    const totals = emptyAuditTotals();
    const outcome = await runPool(files, { options, inputRoot: dir, plan: plan.value }, poolPlan, undefined, (p, s) =>
      recordAudit(totals, path.basename(p), auditStatsFromFile(s)),
    );

    // Workers analyzed everything but wrote NOTHING.
    expect(outcome.failures).toBe(0);
    expect(outcome.wrote).toHaveLength(0);
    expect(existsSync(outDir)).toBe(false);
    expect(totals.files).toBe(24);
    expect(totals.filesImprovable).toBe(24); // px-4 py-4 → p-4 is savable everywhere
    expect(totals.bytesSavable).toBeGreaterThan(0);
    expect(totals.worst).toHaveLength(AUDIT_TOP_FILES);
  });

  it('never prints diffs (audit replaces dry-run output)', async () => {
    writeFileSync(
      path.join(dir, 'A.tsx'),
      'export default function A(){return (<div className="px-4 py-4 bg-white">hi</div>);}\n',
    );
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await execute(parseInvocation([dir, '--audit', '--yes']));
    const logged = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain('---'); // no unified diff header
    expect(logged).not.toContain('+++');
  });
});
