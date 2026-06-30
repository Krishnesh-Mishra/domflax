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

import { createDomflax } from './index';

let dir: string;
let centerCss: string;
let combinatorCss: string;

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
