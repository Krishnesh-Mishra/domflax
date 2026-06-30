import { describe, it, expect } from 'vitest';

import { createDomflax } from '../src/index';

/* ───────────────────────── verify OFF (default) — conservative, never changes rendering ───────────────────────── */

describe('createDomflax().transform — verify off (default) is conservative', () => {
  it('does NOT flatten a flex-centering wrapper (needs-verification: display:flex establishes context)', () => {
    const code =
      '<div className="w-full h-full flex justify-center items-center">' +
      '<div className="h-10 w-10 bg-red-200">Hello</div>' +
      '</div>';

    const { code: out } = createDomflax().transform(code, 'App.tsx');

    // The wrapper SURVIVES — its centering is preserved, no flatten happened.
    expect(out).toContain('justify-center');
    expect(out).toContain('items-center');
    expect(out).not.toContain('place-self-center');

    // The child survived and was still compressed (compress is independent of the flatten gate):
    // h-10 w-10 → size-10.
    expect(out).toContain('size-10');
    expect(out).toContain('bg-red-200');
    expect(out).toContain('Hello');
  });

  it('does NOT flatten a padding wrapper (px-4 py-4 … flex …) — dropping padding would shift the child', () => {
    const code =
      '<div className="px-4 py-4 flex items-center justify-center">' +
      '<div className="w-4 h-4 bg-red-500">x</div>' +
      '</div>';

    const { code: out } = createDomflax().transform(code, 'App.tsx');

    // Wrapper preserved; its padding survives (compressed px-4 py-4 → p-4) — NOT dropped.
    expect(out).toContain('p-4');
    expect(out).not.toContain('place-self-center');
    expect(out).toContain('bg-red-500');
  });

  it('DOES apply a provably-safe flatten (display:contents wrapper contributes nothing)', () => {
    const code = '<div className="contents"><a className="text-blue-500">Link</a></div>';
    const { code: out } = createDomflax().transform(code, 'App.tsx');

    // The display:contents box generates no box of its own ⇒ removing it is layout-identical.
    expect(out).not.toContain('contents');
    expect(out).toContain('text-blue-500');
    expect(out).toContain('Link');
  });

  it('DOES apply a provably-safe flatten (empty-style div wrapping a single child)', () => {
    const code = '<div><span className="bg-red-200">Hi</span></div>';
    const { code: out } = createDomflax().transform(code, 'App.tsx');

    // A layout-neutral, style-free div is hoisted into its sole child.
    expect(out).toContain('<span');
    expect(out).toContain('bg-red-200');
    expect(out).toContain('Hi');
  });

  it('compresses px-4 py-4 to the single p-4 utility (reverse-emit minimization)', () => {
    const code = '<div className="px-4 py-4 bg-white">x</div>';
    const { code: out } = createDomflax().transform(code, 'App.tsx');

    expect(out).toContain('p-4');
    expect(out).not.toContain('px-4');
    expect(out).not.toContain('py-4');
    expect(out).toContain('bg-white');
  });

  it('does NOT flatten a centering wrapper that carries an onClick (opacity barrier)', () => {
    const code =
      '<div className="w-full h-full flex justify-center items-center" onClick={handleClick}>' +
      '<div className="h-10 w-10 bg-red-200">Hello</div>' +
      '</div>';

    const { code: out } = createDomflax().transform(code, 'App.tsx');

    expect(out).toContain('justify-center');
    expect(out).toContain('items-center');
    expect(out).toContain('onClick={handleClick}');
    expect(out).not.toContain('place-self-center');
    expect(out).toContain('bg-red-200');
    expect(out).toContain('Hello');
  });

  it('leaves non-jsx/tsx files untouched (passthrough)', () => {
    const css = '.x { color: red }';
    const { code: out, map } = createDomflax().transform(css, 'styles.css');
    expect(out).toBe(css);
    expect(map).toBeNull();
  });
});

/* ───────────────────────── REAL-MODULE round-trip (the regression that hid the bug) ───────────────────────── */

describe('createDomflax().transform — full modules survive surgery (verify off)', () => {
  const CARD = [
    "import React from 'react';",
    '',
    'export default function Card({ title }) {',
    '  return (',
    '    <div className="w-full h-full flex justify-center items-center">',
    '      <div className="px-4 py-4 bg-white">{title}</div>',
    '    </div>',
    '  );',
    '}',
    '',
  ].join('\n');

  it('keeps the flex wrapper (no rendering change) but still COMPRESSES the dynamic-child div', () => {
    const { code: out } = createDomflax().transform(CARD, 'Card.tsx');

    // surrounding module survives …
    expect(out).toContain("import React from 'react';");
    expect(out).toContain('export default function Card({ title })');
    expect(out).toContain('return (');
    expect(out).toContain('{title}');

    // … the flex-centering wrapper is PRESERVED (verify off never changes rendering) …
    expect(out).toContain('justify-center');
    expect(out).toContain('items-center');
    expect(out).not.toContain('place-self-center');

    // … and the inner div COMPRESSES (px-4 py-4 → p-4) even though it has a dynamic `{title}` child:
    //     compress only rewrites the element's OWN class tokens, so a dynamic child never blocks it.
    expect(out).toContain('p-4');
    expect(out).not.toContain('px-4');
    expect(out).not.toContain('py-4');
    expect(out).toContain('bg-white');

    // The output is still a valid, complete module (re-transforming it does not explode).
    expect(() => createDomflax().transform(out, 'Card.tsx')).not.toThrow();
  });

  it('handles two components in one module, a .map() row, and dangerouslySetInnerHTML', () => {
    const code = [
      "import React from 'react';",
      '',
      'export function List({ items }) {',
      '  return (',
      '    <ul className="gap-4">',
      '      <li className="px-2 py-2">Header</li>',
      '      {items.map((it) => (',
      '        <li key={it.id} className="mx-2 my-2">{it.label}</li>',
      '      ))}',
      '    </ul>',
      '  );',
      '}',
      '',
      'export function Raw({ html }) {',
      '  return <span dangerouslySetInnerHTML={{ __html: html }} />;',
      '}',
      '',
    ].join('\n');

    const { code: out } = createDomflax().transform(code, 'List.tsx');

    expect(out).toContain('import React from \'react\';');
    expect(out).toContain('export function List({ items })');
    expect(out).toContain('export function Raw({ html })');

    expect(out).toContain('{items.map((it) => (');
    expect(out).toContain('key={it.id}');
    expect(out).toContain('{it.label}');

    expect(out).toContain('dangerouslySetInnerHTML={{ __html: html }}');

    // The static <li> compressed px-2 py-2 → p-2 …
    expect(out).toContain('className="p-2"');
    expect(out).not.toContain('px-2');
    expect(out).not.toContain('py-2');

    // … and the mapped <li> ALSO compresses mx-2 my-2 → m-2, even though its `{it.label}` child is
    //     dynamic: compress rewrites only the element's own class tokens (no child is affected).
    expect(out).toContain('className="m-2"');
    expect(out).not.toContain('mx-2');
    expect(out).not.toContain('my-2');

    // The <ul>'s single `gap-4` token has nothing to fold, so it stays put.
    expect(out).toContain('className="gap-4"');
  });
});
