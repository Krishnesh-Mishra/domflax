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
