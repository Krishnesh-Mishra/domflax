import { describe, it, expect } from 'vitest';

import { createDomflax } from './index';

/* ───────────────────────── end-to-end transform (parse → resolve → flatten → emit) ───────────────────────── */

describe('createDomflax().transform — end to end', () => {
  it('flattens a flex-centering wrapper, pushing place-self-center onto the surviving child', () => {
    const code =
      '<div className="w-full h-full flex justify-center items-center">' +
      '<div className="h-10 w-10 bg-red-200">Hello</div>' +
      '</div>';

    const { code: out } = createDomflax().transform(code, 'App.tsx');

    // wrapper is gone …
    expect(out).not.toContain('w-full');
    expect(out).not.toContain('justify-center');
    expect(out).not.toContain('items-center');

    // … the child survived, keeping its own styles — and its equal width/height (`h-10 w-10`)
    //     was compressed to the shorter `size-10` by the minimizing reverse-emit.
    expect(out).toContain('size-10');
    expect(out).not.toContain('h-10');
    expect(out).not.toContain('w-10');
    expect(out).toContain('bg-red-200');

    // … gained the centering intent as a class …
    expect(out).toContain('place-self-center');

    // … and kept its text content.
    expect(out).toContain('Hello');
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

    // wrapper survives intact: its classes and handler are still present …
    expect(out).toContain('justify-center');
    expect(out).toContain('items-center');
    expect(out).toContain('onClick={handleClick}');

    // … and the centering intent was NOT pushed down (no flattening happened).
    expect(out).not.toContain('place-self-center');

    // child is still there.
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

// The bare-fragment fixtures above can't catch a backend that drops the surrounding module. These
// feed a COMPLETE module (imports + `export default function` + hooks + `return (…)` + `{title}` hole)
// and assert BOTH that the optimization applied AND that every surrounding byte survived.
describe('createDomflax().transform — full modules survive surgery', () => {
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

  it('flattens the wrapper and compresses px-4 py-4 → p-4 while keeping import/export/function/{title}', () => {
    const { code: out } = createDomflax().transform(CARD, 'Card.tsx');

    // surrounding module survives …
    expect(out).toContain("import React from 'react';");
    expect(out).toContain('export default function Card({ title })');
    expect(out).toContain('return (');
    expect(out).toContain('{title}'); // the dynamic hole is preserved verbatim

    // … the flex-centering wrapper flattened …
    expect(out).not.toContain('w-full');
    expect(out).not.toContain('justify-center');
    expect(out).not.toContain('items-center');

    // … the surviving child gained the centering intent …
    expect(out).toContain('place-self-center');

    // … and px-4 py-4 collapsed to p-4 (compress), bg-white kept.
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

    // Both components and all dynamic JS survive verbatim.
    expect(out).toContain('import React from \'react\';');
    expect(out).toContain('export function List({ items })');
    expect(out).toContain('export function Raw({ html })');

    // The `.map(...)` row is preserved verbatim — its `{expr}` body, `key=`, and inner `{it.label}`
    // hole are untouched (the JSX inside the callback is opaque, so its classes are NOT rewritten).
    expect(out).toContain('{items.map((it) => (');
    expect(out).toContain('key={it.id}');
    expect(out).toContain('className="mx-2 my-2"');
    expect(out).toContain('{it.label}');

    // dangerouslySetInnerHTML is an opacity barrier — preserved verbatim.
    expect(out).toContain('dangerouslySetInnerHTML={{ __html: html }}');

    // The static (non-dynamic-child) <li> compressed px-2 py-2 → p-2 …
    expect(out).toContain('className="p-2"');
    expect(out).not.toContain('px-2');
    expect(out).not.toContain('py-2');

    // … while the <ul> (which has dynamic children) stays put — no spurious rewrite.
    expect(out).toContain('className="gap-4"');
  });
});
