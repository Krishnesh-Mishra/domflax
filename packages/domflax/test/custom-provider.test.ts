/**
 * domflax — custom-CSS provider e2e (T4 selector-safety + T5 emittability).
 *
 * Runs the real engine against the `'custom'` provider, backed by on-disk stylesheets written into a
 * temp dir for the test. Asserts:
 *
 *   • T4 — a wrapper a COMBINATOR/descendant selector depends on (`.list > .item h3`) is PRESERVED
 *     (unwrapping it would change the selector match-set); a Tailwind flex-center wrapper with NO
 *     selector dependents STILL flattens.
 *   • T5 — a flex-centering wrapper whose compensating `place-self:center` is NOT reproducible by the
 *     custom CSS (no such utility) is PRESERVED (centering would otherwise be silently dropped); the
 *     Tailwind case (place-self-center IS emittable) STILL flattens.
 */

import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDomflax } from '../src/index';

let dir: string;
let centerCss: string;
let combinatorCss: string;
let inflateCss: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'domflax-custom-'));

  centerCss = join(dir, 'center.css');
  writeFileSync(
    centerCss,
    '.center{display:flex;align-items:center;justify-content:center}\n.card{background:#fff}\n',
    'utf8',
  );

  combinatorCss = join(dir, 'combinator.css');
  writeFileSync(
    combinatorCss,
    '.list > .item h3 { color: red }\n.item { display:flex; align-items:center; justify-content:center }\n',
    'utf8',
  );

  // Reverse-emit inflation repro: `.bg-cream-deep` is a redundant ALTERNATIVE to `.product-art`'s
  // background (declared FIRST, so the greedy reverse cover would pick it). `.product-art` is
  // selector-bound (compound `.product-art.bordered`) → non-droppable/retained. `.passthrough` is an
  // inert display:contents wrapper that flattens (a genuine node-removal win on the same document).
  inflateCss = join(dir, 'inflate.css');
  writeFileSync(
    inflateCss,
    [
      '.bg-cream-deep { background:#efe9dd }',
      '.product-art { background:#efe9dd }',
      '.product-art.bordered { border:1px solid #000 }',
      '.passthrough { display:contents }',
      '',
    ].join('\n'),
    'utf8',
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/* ───────────────────────── T5 — emittability ───────────────────────── */

describe('custom provider — T5 emittability (centering must not be silently dropped)', () => {
  it('PRESERVES a .center wrapper whose place-self:center is not reproducible by the custom CSS', () => {
    const code =
      'export default function B(){return (<div className="center"><div className="card">{y}</div></div>);}';
    const { code: out } = createDomflax({ provider: 'custom', cssFiles: [centerCss] }).transform(code, 'B.tsx');

    // The wrapper survives — centering is preserved (NOT flattened away).
    expect(out).toContain('className="center"');
    expect(out).toContain('className="card"');
    expect(out).toContain('{y}');
  });

  it('verify off: the Tailwind flex-center wrapper is also PRESERVED (needs-verification, not committed)', () => {
    const code =
      '<div className="flex justify-center items-center"><div className="bg-red-200">x</div></div>';
    const { code: out } = createDomflax().transform(code, 'A.tsx');

    // With verify off, even a fully-emittable flex-center flatten is conservative (display:flex
    // establishes a context the child's NEW parent may not provide) — so the wrapper stays.
    expect(out).toContain('justify-center');
    expect(out).not.toContain('place-self-center');
    expect(out).toContain('bg-red-200');
  });
});

/* ───────────────────────── T4 — selector safety ───────────────────────── */

describe('custom provider — T4 selector safety (combinator dependents preserved)', () => {
  it('PRESERVES .list and .item wrappers a combinator/descendant selector depends on', () => {
    const code = '<div className="list"><div className="item"><span className="x">{a}</span></div></div>';
    const { code: out } = createDomflax({ provider: 'custom', cssFiles: [combinatorCss] }).transform(
      code,
      'C.tsx',
    );

    // `.list > .item h3` makes both wrappers structurally load-bearing — neither may be flattened.
    expect(out).toContain('className="list"');
    expect(out).toContain('className="item"');
    expect(out).toContain('{a}');
  });

  it('verify off: a Tailwind flex-center wrapper with no selector dependents is still PRESERVED', () => {
    const code = '<div className="flex justify-center items-center"><a className="bg-red-200">L</a></div>';
    const { code: out } = createDomflax().transform(code, 'D.tsx');

    // No combinator dependents, but display:flex makes this needs-verification ⇒ conservative by default.
    expect(out).toContain('justify-center');
    expect(out).not.toContain('place-self-center');
    expect(out).toContain('bg-red-200');
  });
});

/* ───────────── reverse-emit must never INFLATE an unchanged element (byte-identical bystander) ───────────── */

describe('custom provider — unchanged elements stay byte-identical (no inflation)', () => {
  it('HTML: a bystander .product-art keeps its class byte-identical while its inert child flattens', () => {
    // `.product-art` is touched ONLY as a structural bystander (its inert `.passthrough` child is
    // flattened). Its computed never changes, so it must NOT gain the redundant `.bg-cream-deep`
    // (pre-fix, the greedy reverse cover appended it since `.bg-cream-deep` is declared first).
    const src =
      '<div class="product-art"><div class="passthrough"><img src="a.png"></div></div>';
    const { code: out } = createDomflax({ provider: 'custom', cssFiles: [inflateCss] }).transform(
      src,
      'index.html',
    );

    // 1. Unchanged element is byte-identical — NO redundant class was added.
    expect(out).toContain('class="product-art"');
    expect(out).not.toContain('bg-cream-deep');
    // 2. The inert display:contents wrapper still flattens (its child is hoisted) — a genuine win.
    expect(out).not.toContain('passthrough');
    expect(out).toContain('<img');
    expect(out).toBe('<div class="product-art"><img src="a.png"></div>');
  });

  it('JSX: same invariants — bystander byte-identical, inert wrapper flattens', () => {
    const code =
      'export default function G(){return (' +
      '<div className="product-art"><div className="passthrough"><img src="a.png"/></div></div>' +
      ');}';
    const { code: out } = createDomflax({ provider: 'custom', cssFiles: [inflateCss] }).transform(
      code,
      'G.tsx',
    );

    expect(out).toContain('className="product-art"');
    expect(out).not.toContain('bg-cream-deep');
    expect(out).not.toContain('passthrough');
    expect(out).toContain('<img');
  });

  it('a genuine compression (Tailwind sibling) is unaffected by the no-inflation fix', () => {
    // Invariant #3: the fix narrows reverse-emit to style-dirty elements but must not disable a real
    // compression. A Tailwind px-4 py-4 element still folds to the single p-4.
    const { code: out } = createDomflax().transform('<div className="px-4 py-4 bg-white">x</div>', 'S.tsx');
    expect(out).toContain('p-4');
    expect(out).not.toContain('px-4');
    expect(out).not.toContain('py-4');
    expect(out).toContain('bg-white');
  });
});
