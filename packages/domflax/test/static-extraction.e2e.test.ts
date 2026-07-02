import { describe, it, expect } from 'vitest';

import { createDomflax } from '../src/index';

/**
 * STATIC EXTRACTION e2e — cn()/clsx()/template-literal classNames: the provably-static string
 * chunks are compressed segment-locally (order-safe), every dynamic part stays byte-for-byte,
 * and the element remains OPAQUE for flatten (the full class set is unknown at build time).
 */

function transform(code: string): string {
  return createDomflax().transform(code, 'App.tsx').code;
}

describe('static extraction — cn()/clsx() calls', () => {
  it('compresses the static cn() argument; dynamic args byte-identical', () => {
    const code =
      'const A = ({ active, ...props }) => (\n' +
      '  <div className={cn("px-4 py-4 h-10 w-10", active && "bg-red-500", props.cls)}>x</div>\n' +
      ');\n';
    const out = transform(code);
    expect(out).toBe(
      'const A = ({ active, ...props }) => (\n' +
        '  <div className={cn("p-4 size-10", active && "bg-red-500", props.cls)}>x</div>\n' +
        ');\n',
    );
  });

  it('recognizes clsx and twMerge the same way', () => {
    const clsxOut = transform('const A = () => <div className={clsx("px-2 py-2", c && "x")}>x</div>;');
    expect(clsxOut).toContain('clsx("p-2", c && "x")');

    const twOut = transform('const A = () => <div className={twMerge("mx-2 my-2", props.cls)}>x</div>;');
    expect(twOut).toContain('twMerge("m-2", props.cls)');
  });

  it('preserves the segment position among the arguments (later-wins order safety)', () => {
    const code = 'const A = () => <div className={cn("px-4 py-4", cond && "p-2")}>x</div>;';
    const out = transform(code);
    // The compressed set replaces the FIRST argument in place — `p-2` still wins when cond is true.
    expect(out).toContain('cn("p-4", cond && "p-2")');
  });

  it('retains a non-droppable (variant) token verbatim while compressing around it', () => {
    const code = 'const A = () => <div className={cn("px-4 py-4 hover:bg-red-500", x)}>x</div>;';
    const out = transform(code);
    expect(out).toContain('hover:bg-red-500');
    expect(out).toContain('p-4');
    expect(out).not.toContain('px-4');
    expect(out).not.toContain('py-4');
  });

  it('an UNKNOWN wrapper fn (myCn) stays fully opaque — byte-identical output', () => {
    const code = 'const A = () => <div className={myCn("px-4 py-4", x)}>x</div>;\n';
    expect(transform(code)).toBe(code);
  });

  it('a segment containing an unresolved token (js-hook) stays untouched', () => {
    const code = 'const A = () => <div className={cn("px-4 js-hook", x)}>x</div>;\n';
    expect(transform(code)).toBe(code);
  });
});

describe('static extraction — template literals', () => {
  it('compresses each static chunk independently; ${expr} and boundary whitespace untouched', () => {
    const code = 'const A = () => <div className={`px-4 py-4 ${x} mt-2 mb-2`}>x</div>;\n';
    const out = transform(code);
    expect(out).toBe('const A = () => <div className={`p-4 ${x} my-2`}>x</div>;\n');
  });

  it('never rewrites a chunk with a partial token at a ${} boundary', () => {
    const code = 'const A = () => <div className={`px-${n} mt-2 mb-2`}>x</div>;\n';
    const out = transform(code);
    expect(out).toBe('const A = () => <div className={`px-${n} my-2`}>x</div>;\n');
  });
});

describe('static extraction — safety invariants', () => {
  it('an element with a dynamic className is still NEVER flattened', () => {
    // A static `contents` wrapper WOULD be flattened (provably safe). With a dynamic segment in
    // play the true class set is unknown, so the wrapper must survive.
    const staticCode = '<div className="contents"><a className="text-blue-500">L</a></div>';
    expect(transform(staticCode)).not.toContain('contents'); // baseline: static IS flattened

    const dynamicCode =
      '<div className={cn("contents", active && "hidden")}><a className="text-blue-500">L</a></div>';
    const out = transform(dynamicCode);
    expect(out).toContain('cn("contents", active && "hidden")');
    expect(out).toContain('<div');
  });

  it('is idempotent: re-transforming the output changes nothing', () => {
    const code =
      'const A = ({ active, ...props }) => (\n' +
      '  <div className={cn("px-4 py-4 h-10 w-10", active && "bg-red-500", props.cls)}>\n' +
      '    <span className={`mt-2 mb-2 ${props.extra}`}>y</span>\n' +
      '  </div>\n' +
      ');\n';
    const once = transform(code);
    expect(once).toContain('cn("p-4 size-10", active && "bg-red-500", props.cls)');
    expect(once).toContain('`my-2 ${props.extra}`');
    expect(transform(once)).toBe(once);
  });

  it('a realistic shadcn-style snippet: statics compress, dynamics byte-identical', () => {
    const code = [
      'export function Button({ className, variant, ...props }) {',
      '  return (',
      '    <button',
      '      className={cn(',
      '        "inline-flex items-center justify-center px-4 py-4 h-10 w-10 rounded-md",',
      '        variant === "ghost" && "bg-transparent hover:bg-accent",',
      '        className,',
      '      )}',
      '      {...props}',
      '    />',
      '  );',
      '}',
      '',
    ].join('\n');
    const out = transform(code);

    // static chunk compressed in place (px-4 py-4 → p-4, h-10 w-10 → size-10; kept tokens stay in
    // source order, freshly-emitted shorthands append) …
    expect(out).toContain('"inline-flex items-center justify-center rounded-md p-4 size-10",');
    // … dynamic args + spread + module shell byte-identical.
    expect(out).toContain('variant === "ghost" && "bg-transparent hover:bg-accent",');
    expect(out).toContain('className,');
    expect(out).toContain('{...props}');
    expect(out).toContain('export function Button({ className, variant, ...props })');
  });
});
