/**
 * domflax — the provably-sound, context-aware centering flatten.
 *
 * A flex/grid centering wrapper
 *
 *   <P grid><W flex/grid items-center justify-center><C/></W></P>
 *
 * collapses to
 *
 *   <P grid><C place-self:center/></P>
 *
 * ONLY when it is render-identical. `place-self:center` = `align-self:center` + `justify-self:center`;
 * BOTH halves are honored only inside a GRID formatting context. So the flatten is gated on the child's
 * NEW parent being a statically-known grid that lets the wrapper fill its area — plus the wrapper being a
 * pure single-child centerer that drops nothing. Every other shape (flex/block/unknown parent, a wrapper
 * with padding, multiple children, a non-stretch grid parent, …) stays PRESERVED — the conservative
 * default, which never changes rendering.
 *
 * Two layers of proof:
 *   • the plain transform matrix below (HTML + JSX) asserts domflax applies the flatten for EXACTLY the
 *     grid-parent case and preserves the wrapper everywhere else;
 *   • the Chromium suite renders BEFORE vs AFTER through `@domflax/verify` and proves the grid rewrite is
 *     pixel/box/style IDENTICAL, while the flex parent (and the non-qualifying shapes) genuinely DIVERGE —
 *     which is the whole reason the gate refuses them.
 */

import { describe, expect, it } from 'vitest';

import { isBrowserAvailable, verifyEquivalence } from '@domflax/verify';

import { createDomflax } from '../src/index';

const df = createDomflax();
const ws = (s: string): string => s.replace(/\s+/g, ' ').trim();

/* A pure flex-centering wrapper around a single painted child, under a parent with the given classes. */
const nestedJsx = (parent: string): string =>
  `<div className="${parent}"><div className="flex items-center justify-center">` +
  `<div className="bg-red-500">x</div></div></div>`;
const nestedHtml = (parent: string): string =>
  `<div class="${parent}"><div class="flex items-center justify-center">` +
  `<div class="bg-red-500">x</div></div></div>`;

/* ───────────────────────── Part A — the transform matrix (no browser) ───────────────────────── */

describe('centering flatten — applied ONLY under a statically-known grid parent', () => {
  it('JSX: grid parent + pure centering wrapper + single child → FLATTENED (child gains place-self-center)', () => {
    const { code: out } = df.transform(nestedJsx('grid'), 'App.tsx');
    // Wrapper box removed; its centering is compensated by place-self-center on the surviving child.
    expect(ws(out)).toBe('<div className="grid"><div className="bg-red-500 place-self-center">x</div></div>');
    expect(out).not.toContain('items-center');
    expect(out).not.toContain('justify-center');
  });

  it('HTML: same flatten through the parse5 pipeline (parent display resolved from computed styles)', () => {
    const { code: out } = df.transform(nestedHtml('grid'), 'index.html');
    expect(ws(out)).toBe('<div class="grid"><div class="bg-red-500 place-self-center">x</div></div>');
  });

  it('JSX: FLEX parent (items-start) — PRESERVED (justify-self ignored in flex ⇒ not provably safe)', () => {
    const { code: out } = df.transform(nestedJsx('flex items-start'), 'App.tsx');
    expect(out).not.toContain('place-self-center');
    expect(out).toContain('items-center');
    expect(out).toContain('justify-center');
  });

  it('JSX: FLEX parent (default stretch) — PRESERVED (the whole flex class is skipped)', () => {
    const { code: out } = df.transform(nestedJsx('flex'), 'App.tsx');
    expect(out).not.toContain('place-self-center');
    expect(out).toContain('justify-center');
  });

  it('HTML: FLEX parent — PRESERVED', () => {
    const { code: out } = df.transform(nestedHtml('flex items-start'), 'index.html');
    expect(out).not.toContain('place-self-center');
    expect(out).toContain('items-center');
  });

  it('JSX: BLOCK parent — centering wrapper PRESERVED (place-self would not center in block flow)', () => {
    const { code: out } = df.transform(nestedJsx('block'), 'App.tsx');
    // (The inert `block` box may itself be hoisted, but the centering wrapper must survive intact.)
    expect(out).not.toContain('place-self-center');
    expect(out).toContain('items-center');
    expect(out).toContain('justify-center');
  });

  it('JSX: grid parent but wrapper carries padding — PRESERVED (rule 3: removal would drop the padding)', () => {
    const code =
      '<div className="grid"><div className="p-4 flex items-center justify-center">' +
      '<div className="bg-red-500">x</div></div></div>';
    const { code: out } = df.transform(code, 'App.tsx');
    expect(out).not.toContain('place-self-center');
    expect(out).toContain('p-4');
    expect(out).toContain('items-center');
  });

  it('JSX: grid parent forcing place-items-center — PRESERVED (fill guard: wrapper would not fill its area)', () => {
    const { code: out } = df.transform(nestedJsx('grid place-items-center'), 'App.tsx');
    expect(out).not.toContain('place-self-center');
    expect(out).toContain('place-items-center');
    expect(out).toContain('items-center');
  });

  it('JSX: grid parent but wrapper has two element children — PRESERVED (rule 4: not a single-child centerer)', () => {
    const code =
      '<div className="grid"><div className="flex items-center justify-center">' +
      '<div className="bg-red-500">x</div><div className="bg-blue-500">y</div></div></div>';
    const { code: out } = df.transform(code, 'App.tsx');
    expect(out).not.toContain('place-self-center');
    expect(out).toContain('items-center');
  });
});

/* ───────────────────────── Part B — Chromium render-identity proof ───────────────────────── */

// Probe once at module load; browser tests SKIP cleanly when chromium is not installed.
const hasBrowser = await isBrowserAvailable();
if (!hasBrowser) {
  // eslint-disable-next-line no-console
  console.warn('[centering-flatten] chromium not installed — skipping render-identity proof.');
}

const SMALL = [{ name: 'box', width: 200, height: 200, deviceScaleFactor: 1 }] as const;
const target = (label: string, code: string) => ({ label, code, id: `mem://${label}` });

/** BEFORE: a centering wrapper nested under `parentStyle`. Sized so centering is observable. */
const before = (parentStyle: string, wrapperStyle = ''): string =>
  `<div style="width:200px;height:200px;${parentStyle};background:#fff">` +
  `<div style="${wrapperStyle}display:flex;align-items:center;justify-content:center">` +
  `<div style="width:50px;height:50px;background:#f00"></div></div></div>`;
/** AFTER: the wrapper collapsed to place-self:center on the child (what the flatten emits). */
const after = (parentStyle: string): string =>
  `<div style="width:200px;height:200px;${parentStyle};background:#fff">` +
  `<div style="width:50px;height:50px;background:#f00;place-self:center"></div></div>`;

describe('centering flatten — Chromium proves render-identity (grid) and divergence (everything else)', () => {
  it.skipIf(!hasBrowser)(
    'GRID parent: BEFORE ≡ AFTER — the applied flatten is pixel/box/style IDENTICAL',
    async () => {
      const r = await verifyEquivalence(
        target('before', before('display:grid')),
        target('after', after('display:grid')),
        { viewports: SMALL, maxPixelRatio: 0.002 },
      );
      expect(r.equivalence).toBe('equivalent');
      expect(r.viewports[0]!.boxes.every((b) => b.maxDelta <= 0.5)).toBe(true);
      expect(r.viewports[0]!.styles).toHaveLength(0);
    },
    60_000,
  );

  it.skipIf(!hasBrowser)(
    'FLEX parent (same wrapper): flattening WOULD DIVERGE — the gate correctly refuses it',
    async () => {
      const r = await verifyEquivalence(
        target('before', before('display:flex;align-items:flex-start')),
        target('after', after('display:flex;align-items:flex-start')),
        { viewports: SMALL, maxPixelRatio: 0.002 },
      );
      expect(r.equivalence).toBe('divergent');
      // The child jumps a full half-container: place-self:center's justify/align is not reproduced here.
      expect(r.viewports[0]!.boxes.some((b) => b.maxDelta > 0.5)).toBe(true);
    },
    60_000,
  );

  it.skipIf(!hasBrowser)(
    'GRID parent forcing items-start: flattening WOULD DIVERGE — justifies the fill guard',
    async () => {
      const r = await verifyEquivalence(
        target('before', before('display:grid;align-items:start;justify-items:start')),
        target('after', after('display:grid;align-items:start;justify-items:start')),
        { viewports: SMALL, maxPixelRatio: 0.002 },
      );
      expect(r.equivalence).toBe('divergent');
    },
    60_000,
  );

  it.skipIf(!hasBrowser)(
    'GRID parent + padded wrapper: flattening WOULD DIVERGE — justifies rule 3 (dropped padding shifts child)',
    async () => {
      const r = await verifyEquivalence(
        target('before', before('display:grid', 'padding-left:60px;')),
        target('after', after('display:grid')),
        { viewports: SMALL, maxPixelRatio: 0.002 },
      );
      expect(r.equivalence).toBe('divergent');
    },
    60_000,
  );
});
