import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  accumulateOnCompilation,
  addStats,
  emptyTotals,
  formatBytes,
  formatCount,
  printCompilationSummary,
  renderSummary,
  resetTotals,
  zeroStats,
  type Totals,
} from '../src/summary';

/* ───────────────────────────── formatBytes ───────────────────────────── */

describe('formatBytes', () => {
  it('keeps sub-KiB values as plain bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('crosses into KB/MB/GB at 1024 boundaries with one decimal', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(19170)).toBe('18.7 KB'); // ~18.7 KiB, matches the spec example
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe('5.0 GB');
  });

  it('handles negative sizes (net growth) symmetrically', () => {
    expect(formatBytes(-512)).toBe('-512 B');
    expect(formatBytes(-2048)).toBe('-2.0 KB');
  });
});

/* ───────────────────────────── formatCount ───────────────────────────── */

describe('formatCount', () => {
  it('inserts thousands separators', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(42)).toBe('42');
    expect(formatCount(318)).toBe('318');
    expect(formatCount(1204)).toBe('1,204');
    expect(formatCount(1000000)).toBe('1,000,000');
  });
});

/* ───────────────────────────── totals ───────────────────────────── */

describe('Totals accumulation', () => {
  it('addStats folds only changed files and sums the deltas', () => {
    const t = emptyTotals();
    addStats(t, { nodesRemoved: 10, classesSaved: 4, bytesSaved: 100 }, true);
    addStats(t, { nodesRemoved: 5, classesSaved: 2, bytesSaved: 50 }, true);
    addStats(t, { nodesRemoved: 99, classesSaved: 99, bytesSaved: 99 }, false); // unchanged → ignored
    expect(t).toEqual({ files: 2, nodesRemoved: 15, classesCompressed: 6, bytesSaved: 150 });
  });

  it('resetTotals zeroes in place', () => {
    const t: Totals = { files: 3, nodesRemoved: 1, classesCompressed: 2, bytesSaved: 3 };
    resetTotals(t);
    expect(t).toEqual(emptyTotals());
  });

  it('zeroStats is an all-zero delta', () => {
    expect(zeroStats()).toEqual({ nodesRemoved: 0, classesSaved: 0, bytesSaved: 0 });
  });
});

/* ───────────────────────────── renderSummary ───────────────────────────── */

describe('renderSummary', () => {
  const totals: Totals = { files: 42, nodesRemoved: 318, classesCompressed: 1204, bytesSaved: 19170 };

  it('renders the boxed layout with human-formatted values', () => {
    const out = renderSummary(totals);
    expect(out).toContain('▲ domflax');
    expect(out).toContain('files optimized');
    expect(out).toContain('DOM nodes removed');
    expect(out).toContain('classes compressed');
    expect(out).toContain('size saved');
    // Human formatting flows through.
    expect(out).toContain('1,204');
    expect(out).toContain('18.7 KB');
    // Two horizontal rules bracket the rows.
    const rules = out.split('\n').filter((l) => l.includes('─'));
    expect(rules).toHaveLength(2);
  });

  it('aligns each value to the same column', () => {
    const out = renderSummary(totals);
    const lines = out.split('\n');
    const filesLine = lines.find((l) => l.includes('files optimized'))!;
    const sizeLine = lines.find((l) => l.includes('size saved'))!;
    expect(filesLine.indexOf('42')).toBe(filesLine.length - 2);
    // "files optimized" (15) padded to 20 within a 3-space indent ⇒ value column 23.
    expect(filesLine.indexOf('42')).toBe(23);
    expect(sizeLine.indexOf('18.7 KB')).toBe(23);
  });
});

/* ───────────────────────── webpack compilation bridge ───────────────────────── */

describe('webpack loader ↔ plugin compilation bridge', () => {
  afterEach(() => vi.restoreAllMocks());

  it('accumulates loader deltas on the compilation and the plugin prints them once', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const compilation: Record<string | symbol, unknown> = {};

    // Two loader invocations (as separate bundles would) write to the same compilation object.
    accumulateOnCompilation(compilation, { nodesRemoved: 8, classesSaved: 3, bytesSaved: 200 }, true);
    accumulateOnCompilation(compilation, { nodesRemoved: 2, classesSaved: 1, bytesSaved: 60 }, true);
    accumulateOnCompilation(compilation, { nodesRemoved: 5, classesSaved: 5, bytesSaved: 5 }, false); // no change

    // Plugin `done` hook reads it back (Stats.compilation shape).
    printCompilationSummary(compilation);

    expect(write).toHaveBeenCalledTimes(1);
    const printed = String(write.mock.calls[0]![0]);
    expect(printed).toContain('files optimized');
    expect(printed).toContain('2'); // two changed files
    expect(printed).toContain('10'); // 8 + 2 nodes removed
    expect(printed).toContain('260 B'); // 200 + 60 bytes

    // Second print is latched (guards buildEnd/closeBundle-style double fire).
    printCompilationSummary(compilation);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('stays silent when nothing changed', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const compilation: Record<string | symbol, unknown> = {};
    accumulateOnCompilation(compilation, { nodesRemoved: 0, classesSaved: 0, bytesSaved: 0 }, false);
    printCompilationSummary(compilation);
    expect(write).not.toHaveBeenCalled();
  });

  it('is defensive against a missing/non-object compilation', () => {
    expect(() => accumulateOnCompilation(undefined, zeroStats(), true)).not.toThrow();
    expect(() => printCompilationSummary(null)).not.toThrow();
  });
});
