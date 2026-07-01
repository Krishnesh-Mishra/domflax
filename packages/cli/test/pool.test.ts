import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseInvocation } from '../src/options';
import {
  computeWorkerCount,
  inlineThreshold,
  runPool,
  shouldUsePool,
  type PoolPlan,
} from '../src/pool';
import { planWrites } from '../src/safety';
import { createTransform } from '../src/transform';

/* ───────────────────────── worker-count planning ───────────────────────── */

describe('computeWorkerCount', () => {
  it('a tiny --max-memory degrades to a single worker (slow but never OOM)', () => {
    const plan = computeWorkerCount(parseInvocation(['src', '--max-memory', '1']));
    expect(plan.workers).toBe(1);
    expect(plan.perWorkerCapMB).toBeGreaterThanOrEqual(64);
  });

  it('--concurrency caps the worker count directly', () => {
    const plan = computeWorkerCount(parseInvocation(['src', '--concurrency', '2', '--max-memory', '4096']));
    expect(plan.workers).toBe(2);
  });

  it('memory always clamps below the requested concurrency', () => {
    // 320MB budget / 160MB per worker = 2 workers max, even though 8 were requested.
    const plan = computeWorkerCount(parseInvocation(['src', '--concurrency', '8', '--max-memory', '320']));
    expect(plan.workers).toBe(2);
  });
});

describe('shouldUsePool / inlineThreshold', () => {
  it('small jobs and single-worker plans run inline', () => {
    const solo: PoolPlan = { workers: 1, budgetMB: 100, perWorkerCapMB: 100 };
    expect(shouldUsePool(1000, solo)).toBe(false); // workers <= 1

    const plan: PoolPlan = { workers: 4, budgetMB: 2000, perWorkerCapMB: 500 };
    expect(inlineThreshold(4)).toBe(8);
    expect(shouldUsePool(8, plan)).toBe(false); // not strictly above threshold
    expect(shouldUsePool(9, plan)).toBe(true);
  });
});

/* ───────────────────────── the pool end-to-end ───────────────────────── */

describe('runPool', () => {
  let dir: string;
  let outDir: string;

  const writeInputs = (n: number): string[] => {
    const files: string[] = [];
    for (let i = 0; i < n; i++) {
      const f = path.join(dir, `C${i}.tsx`);
      writeFileSync(f, `export default function C${i}(){return (<div className="px-4 py-4 bg-white">{x}</div>);}\n`);
      files.push(f);
    }
    return files;
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'domflax-pool-'));
    outDir = path.join(dir, '__out');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('processes a many-file dir, producing the SAME output as the inline path', async () => {
    const files = writeInputs(24);
    const options = { ...parseInvocation([dir, '--out', outDir, '--yes']), out: outDir };
    const plan = planWrites(options, true);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const poolPlan: PoolPlan = { workers: 3, budgetMB: 2048, perWorkerCapMB: 512 };
    const outcome = await runPool(files, { options, inputRoot: dir, plan: plan.value }, poolPlan);

    expect(outcome.failures).toBe(0);
    expect(outcome.totals.files).toBe(24);
    expect(outcome.totals.changed).toBe(24);
    expect(outcome.wrote.length).toBe(24);

    // Compare pool output against the inline transform for the same input.
    const inline = createTransform(options);
    for (const f of files) {
      const expected = inline.transformFile(readFileSync(f, 'utf8'), f).code;
      const got = readFileSync(path.join(outDir, path.basename(f)), 'utf8');
      expect(got).toBe(expected);
      expect(got).toContain('p-4'); // px-4 py-4 → p-4 actually happened
    }
  });

  it('reports a broken file as failed while every other file succeeds, exiting cleanly', async () => {
    const good = writeInputs(10);
    const bogus = path.join(dir, 'does-not-exist.tsx'); // read fails inside the worker
    const files = [...good, bogus];
    const options = { ...parseInvocation([dir, '--out', outDir, '--yes']), out: outDir };
    const plan = planWrites(options, true);
    if (!plan.ok) throw new Error('plan failed');

    const poolPlan: PoolPlan = { workers: 2, budgetMB: 2048, perWorkerCapMB: 512 };
    const outcome = await runPool(files, { options, inputRoot: dir, plan: plan.value }, poolPlan);

    expect(outcome.failures).toBe(1);
    expect(outcome.errors.map((e) => e.path)).toContain(bogus);
    expect(outcome.totals.changed).toBe(10); // the 10 good files still optimized
    // Every good file was written.
    for (const f of good) {
      expect(() => readFileSync(path.join(outDir, path.basename(f)), 'utf8')).not.toThrow();
    }
  });

  it('completes with --concurrency=1 + constrained --max-memory (degrade, not crash)', async () => {
    const files = writeInputs(6);
    const options = {
      ...parseInvocation([dir, '--out', outDir, '--yes', '--concurrency', '1', '--max-memory', '512']),
      out: outDir,
    };
    const plan = planWrites(options, true);
    if (!plan.ok) throw new Error('plan failed');

    // Derive the plan exactly as the CLI does: one worker, memory-capped — slow but it still completes.
    const poolPlan = computeWorkerCount(options);
    expect(poolPlan.workers).toBe(1);

    const outcome = await runPool(files, { options, inputRoot: dir, plan: plan.value }, poolPlan);
    expect(outcome.failures).toBe(0);
    expect(outcome.totals.files).toBe(6);
    expect(outcome.totals.changed).toBe(6);
  });
});
