/**
 * @domflax/resolver-tailwind — SAFETY Layer 1: fail LOUDLY on a Tailwind major the v3 resolver cannot
 * drive (v4+), instead of silently resolving every class to empty (which downstream mis-optimizes).
 *
 * We point the resolver at a throwaway project whose `node_modules/tailwindcss/package.json` declares
 * v4. No network, no real v4 install: the resolver reads the version from that package.json, detects
 * the unsupported major, and (a) exposes `unsupportedMajor`, (b) emits a one-time diagnostic, and
 * (c) reports every present class token as `unknown` (empty styles) so files are left unchanged.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTailwindResolver } from '../src/index';

let projectRoot: string;

beforeAll(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'domflax-tw4-'));
  const pkgDir = join(projectRoot, 'node_modules', 'tailwindcss');
  mkdirSync(pkgDir, { recursive: true });
  // Minimal package.json declaring a v4 version — enough for `require('tailwindcss/package.json')`.
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'tailwindcss', version: '4.0.0', main: 'index.js' }),
    'utf8',
  );
  writeFileSync(join(pkgDir, 'index.js'), 'module.exports = {};\n', 'utf8');
});

afterAll(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('Tailwind v4 detection (fail-loud, files left unchanged)', () => {
  it('flags the unsupported major and warns exactly once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // A unique provider guarantees the one-time warning fires for THIS test regardless of order.
      const resolver = createTailwindResolver({ projectRoot, provider: `tw-v4-${Date.now()}` }) as unknown as {
        unsupportedMajor: number | null;
      };
      expect(resolver.unsupportedMajor).toBe(4);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/Tailwind v4/i);
    } finally {
      warn.mockRestore();
    }
  });

  it('reports EVERY present class token as unknown with no resolved styles', () => {
    const resolver = createTailwindResolver({ projectRoot, provider: `tw-v4-b-${Date.now()}` });
    const { styles, resolved, unknown } = resolver.resolve({
      classes: ['px-4', 'py-4', 'bg-white', 'flex'],
    });
    expect(resolved).toEqual([]);
    expect(unknown).toEqual(['px-4', 'py-4', 'bg-white', 'flex']);
    expect(styles.blocks.size).toBe(0);
  });

  it('a supported (real v3) engine is NOT flagged and resolves normally', () => {
    const resolver = createTailwindResolver() as unknown as { unsupportedMajor: number | null };
    expect(resolver.unsupportedMajor).toBeNull();
    const { resolved } = (resolver as unknown as ReturnType<typeof createTailwindResolver>).resolve({
      classes: ['flex'],
    });
    expect(resolved).toEqual(['flex']);
  });
});
