/**
 * 0.3.0 round-3 e2e — arbitrary-value synthesis (A), variant-aware compression (B), and the
 * inline-style ⇄ class converter (C) through the REAL pipeline (`createDomflax().transform`),
 * against the real Tailwind v3 engine and the custom-CSS provider.
 *
 * CORRECTNESS FIRST: every positive case is also asserted IDEMPOTENT (second transform is a no-op),
 * and every safety case asserts byte-preservation of the risky region.
 */

import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDomflax } from '../src/index';

const tw = () => createDomflax();

/** Transform twice and assert the second pass changes nothing (idempotence). */
function transformStable(code: string, id: string, options?: Parameters<typeof createDomflax>[0]): string {
  const engine = options ? createDomflax(options) : tw();
  const once = engine.transform(code, id).code;
  const twice = engine.transform(once, id).code;
  expect(twice).toBe(once);
  return once;
}

/* ───────────────────────── A — arbitrary-value synthesis ───────────────────────── */

describe('e2e — feature A: arbitrary-value folds', () => {
  it('h-[40px] w-[40px] → size-[40px]', () => {
    const out = transformStable('<div className="h-[40px] w-[40px] bg-white">x</div>', 'A.tsx');
    expect(out).toContain('size-[40px]');
    expect(out).not.toContain('h-[40px]');
    expect(out).not.toContain('w-[40px]');
    expect(out).toContain('bg-white');
  });

  it('pt/pb/pl/pr-[7px] → p-[7px]', () => {
    const out = transformStable(
      '<div className="pt-[7px] pb-[7px] pl-[7px] pr-[7px]">x</div>',
      'A2.tsx',
    );
    expect(out).toContain('className="p-[7px]"');
  });
});

/* ───────────────────────── B — variant-aware compression ───────────────────────── */

describe('e2e — feature B: variant-aware compression', () => {
  it('hover:px-4 hover:py-4 → hover:p-4', () => {
    const out = transformStable('<div className="hover:px-4 hover:py-4 bg-white">x</div>', 'B.tsx');
    expect(out).toContain('hover:p-4');
    expect(out).not.toContain('hover:px-4');
    expect(out).not.toContain('hover:py-4');
  });

  it('md:h-10 md:w-10 → md:size-10', () => {
    const out = transformStable('<div className="md:h-10 md:w-10">x</div>', 'B2.tsx');
    expect(out).toContain('className="md:size-10"');
  });

  it('different chains never mix (hover:px-4 md:py-4 preserved)', () => {
    const code = '<div className="hover:px-4 md:py-4">x</div>';
    const out = transformStable(code, 'B3.tsx');
    expect(out).toBe(code); // nothing to compress across chains — byte-identical
  });

  it('an UNKNOWN variant token stays verbatim while base utilities still compress', () => {
    const out = transformStable('<div className="foo:px-4 px-4 py-4">x</div>', 'B4.tsx');
    expect(out).toContain('foo:px-4'); // unresolvable → retained byte-for-byte
    expect(out).toContain('p-4');
    expect(out).not.toMatch(/(?<!foo:)px-4/); // the base pair folded
  });
});

/* ───────────────────────── C — inline-style ⇄ class (JSX / Tailwind) ───────────────────────── */

describe('e2e — feature C: JSX style={{…}} → classes (Tailwind)', () => {
  it("style={{padding: '1rem'}} converts to the enumerated p-4 and the attribute is removed", () => {
    const out = transformStable(
      `<div className="bg-white" style={{padding: '1rem'}}>x</div>`,
      'C.tsx',
    );
    expect(out).toContain('p-4');
    expect(out).not.toContain('style=');
    expect(out).toContain('bg-white');
  });

  it('style={{padding: 16}} (React px number) converts via arbitrary-value synthesis to p-[16px]', () => {
    const out = transformStable('<div className="bg-white" style={{padding: 16}}>x</div>', 'C2.tsx');
    expect(out).toContain('p-[16px]');
    expect(out).not.toContain('style=');
  });

  it('an element with NO class attribute gains one when the conversion shrinks bytes', () => {
    const out = transformStable(`<span style={{marginTop: '0.5rem'}}>x</span>`, 'C3.tsx');
    expect(out).toContain('className="mt-2"');
    expect(out).not.toContain('style=');
  });

  it('a DYNAMIC style value leaves the whole attribute untouched', () => {
    const code = '<div className="bg-white" style={{padding: pad}}>x</div>';
    const out = transformStable(code, 'C4.tsx');
    expect(out).toContain('style={{padding: pad}}');
  });

  it('CASCADE SAFETY: a property also set under a variant (hover:p-2) is NOT converted', () => {
    const code = `<div className="hover:p-2" style={{padding: '1rem'}}>x</div>`;
    const out = transformStable(code, 'C5.tsx');
    expect(out).toContain(`style={{padding: '1rem'}}`); // inline must keep beating hover
  });

  it('spread attrs block conversion (the real style could be overridden/merged)', () => {
    const code = `<div {...rest} className="bg-white" style={{padding: '1rem'}}>x</div>`;
    const out = transformStable(code, 'C6.tsx');
    expect(out).toContain(`style={{padding: '1rem'}}`);
  });

  it('PARTIAL conversion keeps unconvertible declarations inline (custom property survives)', () => {
    const out = transformStable(
      `<div className="bg-white" style={{'--brand': 'red', padding: '1rem'}}>x</div>`,
      'C7.tsx',
    );
    expect(out).toContain('p-4');
    expect(out).toContain(`style={{'--brand': 'red'}}`); // --* stays inline verbatim
  });
});

/* ───────────────────────── C — inline-style ⇄ class (HTML / custom CSS) ───────────────────────── */

describe('e2e — feature C: HTML style="…" → classes (custom-CSS provider)', () => {
  let dir: string;
  let utilCss: string;
  let tagRuleCss: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'domflax-styleconv-'));
    utilCss = join(dir, 'util.css');
    writeFileSync(utilCss, '.card{background:#fff}\n.p-4{padding:16px}\n', 'utf8');
    tagRuleCss = join(dir, 'tag.css');
    writeFileSync(
      tagRuleCss,
      '.card{background:#fff}\n.p-4{padding:16px}\ndiv{padding:4px}\n',
      'utf8',
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('<div class="card" style="padding:16px"> converts to class="card p-4" (shorter + provable)', () => {
    const code = '<!doctype html><html><body><div class="card" style="padding:16px">x</div></body></html>';
    const out = transformStable(code, 'index.html', { provider: 'custom', cssFiles: [utilCss] });
    expect(out).toContain('class="card p-4"');
    expect(out).not.toContain('style=');
  });

  it('CASCADE SAFETY: a bare `div { padding }` rule suppresses the conversion (competesWith)', () => {
    const code = '<!doctype html><html><body><div class="card" style="padding:16px">x</div></body></html>';
    const out = transformStable(code, 'index.html', { provider: 'custom', cssFiles: [tagRuleCss] });
    // Inline style used to beat `div{padding:4px}`; a `.p-4` class would NOT reliably do so.
    expect(out).toContain('style="padding:16px"');
    expect(out).not.toContain('p-4');
  });

  it('!important stays inline (never converted)', () => {
    const code =
      '<!doctype html><html><body><div class="card" style="padding:16px !important">x</div></body></html>';
    const out = transformStable(code, 'index.html', { provider: 'custom', cssFiles: [utilCss] });
    expect(out).toContain('style="padding:16px !important"');
  });

  it('elements with an id (opaque floor) keep their style attribute byte-for-byte', () => {
    const code =
      '<!doctype html><html><body><div id="hero" class="card" style="padding:16px">x</div></body></html>';
    const out = transformStable(code, 'index.html', { provider: 'custom', cssFiles: [utilCss] });
    expect(out).toContain('style="padding:16px"');
  });
});
