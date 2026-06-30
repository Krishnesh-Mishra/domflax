/**
 * @domflax/verify — equivalence oracle tests.
 *
 * These tests drive a REAL headless chromium. On a machine without the browser
 * binary downloaded they SKIP cleanly (so browserless CI stays green) — the
 * availability probe runs once at module load and gates every browser test via
 * `it.skipIf`.
 */

import { describe, expect, it } from 'vitest';

import { isBrowserAvailable, verifyEquivalence } from './index.js';
import { normalizeStyleValue, matchLeaves, diffBoxes } from './diff.js';
import type { LeafSnapshot } from './render.js';
import type { Viewport } from './types.js';

// Probe once. Top-level await is supported in vitest ESM test modules.
const hasBrowser = await isBrowserAvailable();
if (!hasBrowser) {
  // eslint-disable-next-line no-console
  console.warn(
    '[verify] chromium is not installed — skipping browser-backed equivalence tests. ' +
      "Run 'npx playwright install chromium' to enable them.",
  );
}

const SMALL: readonly Viewport[] = [{ name: 'box', width: 200, height: 200, deviceScaleFactor: 1 }];

/** A 50×50 red box centred in a 200×200 white area via a FLEX wrapper. */
const FLEX_CENTER = `
  <div style="width:200px;height:200px;display:flex;align-items:center;justify-content:center;background:#fff">
    <div style="width:50px;height:50px;background:#ff0000"></div>
  </div>`;

/** Same rendered output, achieved via GRID + place-self — different structure. */
const GRID_CENTER = `
  <div style="width:200px;height:200px;display:grid;background:#fff">
    <div style="width:50px;height:50px;background:#ff0000;place-self:center"></div>
  </div>`;

/** Same layout, but the box is BLUE — clearly not equivalent. */
const FLEX_CENTER_BLUE = `
  <div style="width:200px;height:200px;display:flex;align-items:center;justify-content:center;background:#fff">
    <div style="width:50px;height:50px;background:#0000ff"></div>
  </div>`;

/** Same layout, but the box is bigger — clearly not equivalent. */
const FLEX_CENTER_BIG = `
  <div style="width:200px;height:200px;display:flex;align-items:center;justify-content:center;background:#fff">
    <div style="width:90px;height:90px;background:#ff0000"></div>
  </div>`;

const target = (label: string, code: string) => ({ label, code, id: `mem://${label}` });

describe('verifyEquivalence (browser-backed)', () => {
  it.skipIf(!hasBrowser)(
    'reports EQUIVALENT for structurally-different but visually-identical layouts',
    async () => {
      const result = await verifyEquivalence(
        target('before', FLEX_CENTER),
        target('after', GRID_CENTER),
        { viewports: SMALL, maxPixelRatio: 0.002 },
      );
      expect(result.equivalence).toBe('equivalent');
      expect(result.viewports).toHaveLength(1);
      expect(result.viewports[0]!.equivalence).toBe('equivalent');
      expect(result.viewports[0]!.pixel.changedRatio).toBeLessThanOrEqual(0.002);
      expect(result.viewports[0]!.styles).toHaveLength(0);
    },
    60_000,
  );

  it.skipIf(!hasBrowser)('reports DIVERGENT when only the colour differs', async () => {
    const result = await verifyEquivalence(
      target('before', FLEX_CENTER),
      target('after', FLEX_CENTER_BLUE),
      { viewports: SMALL, maxPixelRatio: 0.002 },
    );
    expect(result.equivalence).toBe('divergent');
    expect(result.viewports[0]!.pixel.changedRatio).toBeGreaterThan(0.002);
    // The colour change must surface as a computed-style diff on the matched leaf.
    expect(result.viewports[0]!.styles.some((s) => s.property === 'background-color')).toBe(true);
  }, 60_000);

  it.skipIf(!hasBrowser)('reports DIVERGENT when the box size differs', async () => {
    const result = await verifyEquivalence(
      target('before', FLEX_CENTER),
      target('after', FLEX_CENTER_BIG),
      { viewports: SMALL, maxPixelRatio: 0.002 },
    );
    expect(result.equivalence).toBe('divergent');
    // The size change must surface as a bounding-box drift on the matched leaf.
    expect(result.viewports[0]!.boxes.some((b) => b.maxDelta > 0.5)).toBe(true);
  }, 60_000);

  it.skipIf(hasBrowser)('returns an INCONCLUSIVE verdict when no browser is available', async () => {
    const result = await verifyEquivalence(target('before', FLEX_CENTER), target('after', GRID_CENTER), {
      viewports: SMALL,
    });
    expect(result.equivalence).toBe('inconclusive');
    expect(result.viewports).toHaveLength(0);
    expect(result.diagnostics[0]?.code).toBe('DF_VERIFY_INCONCLUSIVE');
  });
});

/* ── Pure diff-engine tests (no browser needed) ───────────────────────────── */

describe('diff engine (pure)', () => {
  it('normalizes transparent and sub-pixel values', () => {
    expect(normalizeStyleValue('transparent')).toBe('rgba(0, 0, 0, 0)');
    expect(normalizeStyleValue('49.6px')).toBe('50px');
    expect(normalizeStyleValue('  RGB( 255, 0, 0 )  ')).toBe('rgb( 255, 0, 0 )');
  });

  it('matches leaves by role/text/position, not DOM order', () => {
    const mk = (role: string, text: string, x: number, y: number): LeafSnapshot => ({
      tag: role,
      role,
      text,
      box: { x, y, width: 10, height: 10 },
      styles: {},
    });
    // Same two leaves, supplied in opposite order on each side.
    const before = [mk('div', 'a', 0, 0), mk('div', 'b', 0, 100)];
    const after = [mk('div', 'b', 0, 100), mk('div', 'a', 0, 0)];
    const boxes = diffBoxes(matchLeaves(before, after));
    expect(boxes).toHaveLength(2);
    expect(boxes.every((b) => b.maxDelta === 0)).toBe(true);
  });

  it('flags an unmatched leaf with infinite drift', () => {
    const mk = (text: string): LeafSnapshot => ({
      tag: 'div',
      role: 'div',
      text,
      box: { x: 0, y: 0, width: 10, height: 10 },
      styles: {},
    });
    const boxes = diffBoxes(matchLeaves([mk('a')], [mk('a'), mk('b')]));
    expect(boxes.some((b) => b.maxDelta === Number.POSITIVE_INFINITY)).toBe(true);
  });
});
