import { describe, it, expect } from 'vitest';

import { vite, webpack, type DomflaxWebpackCompiler } from './index';

/* ─────────────────────────────── vite() adapter ─────────────────────────────── */

describe('domflax.vite()', () => {
  it('returns a Vite plugin shape (name / enforce / transform)', () => {
    const plugin = vite();
    expect(plugin.name).toBe('domflax');
    expect(plugin.enforce).toBe('pre');
    expect(typeof plugin.transform).toBe('function');
  });

  it('transform flattens a .tsx wrapper (real engine, returns {code,map})', () => {
    const code =
      '<div className="w-full h-full flex justify-center items-center">' +
      '<div className="h-10 w-10 bg-red-200">Hello</div>' +
      '</div>';

    const result = vite().transform(code, 'App.tsx');

    expect(result).not.toBeNull();
    // Vite TransformResult: { code, map }.
    expect(result?.code).toContain('place-self-center');
    expect(result?.code).not.toContain('justify-center');
    expect(result?.code).toContain('bg-red-200');
    expect(result?.map ?? null).toBeNull();
  });

  it('transform strips query suffixes before matching (e.g. App.tsx?used)', () => {
    const code =
      '<div className="w-full h-full flex justify-center items-center">' +
      '<div className="h-10 w-10 bg-red-200">Hello</div>' +
      '</div>';

    const result = vite().transform(code, 'App.tsx?used');
    expect(result).not.toBeNull();
    expect(result?.code).toContain('place-self-center');
  });

  it('transform returns null for an unchanged .tsx module', () => {
    expect(vite().transform('<div>Hello</div>', 'App.tsx')).toBeNull();
  });

  it('transform returns null for a non-jsx/tsx module', () => {
    expect(vite().transform('.x { color: red }', 'styles.css')).toBeNull();
  });
});

/* ─────────────────────────────── webpack() adapter ─────────────────────────────── */

describe('domflax.webpack()', () => {
  it('returns a webpack plugin shape (name / apply)', () => {
    const plugin = webpack();
    expect(plugin.name).toBe('domflax');
    expect(typeof plugin.apply).toBe('function');
  });

  it('apply() injects a pre-enforced .jsx/.tsx loader rule onto the compiler', () => {
    // A bare config object (as Next.js hands you) is enough — apply is duck-typed.
    const compiler: DomflaxWebpackCompiler = { options: {} };
    webpack({ provider: 'tailwind' }).apply(compiler);

    const rules = compiler.options.module?.rules ?? [];
    expect(rules).toHaveLength(1);

    const rule = rules[0] as {
      test: RegExp;
      enforce: string;
      use: { loader: string; options: { provider?: string } }[];
    };
    expect(rule.enforce).toBe('pre');
    expect(rule.test.test('App.tsx')).toBe(true);
    expect(rule.test.test('App.jsx')).toBe(true);
    expect(rule.test.test('main.css')).toBe(false);
    expect(rule.use[0]?.loader).toMatch(/webpack-loader\.cjs$/);
    expect(rule.use[0]?.options.provider).toBe('tailwind');
  });

  it('apply() preserves any pre-existing module rules', () => {
    const existing = { test: /\.css$/ };
    const compiler: DomflaxWebpackCompiler = { options: { module: { rules: [existing] } } };
    webpack().apply(compiler);

    expect(compiler.options.module?.rules).toContain(existing);
    expect(compiler.options.module?.rules).toHaveLength(2);
  });
});
