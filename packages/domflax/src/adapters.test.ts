import { describe, it, expect } from 'vitest';

import domflax, { createDomflax, vite, webpack, type DomflaxWebpackCompiler } from './index';

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

  it('apply() injects a pre-enforced .jsx/.tsx loader rule onto a real webpack Compiler', () => {
    // Real webpack: rules live under `compiler.options.module.rules`.
    const compiler: DomflaxWebpackCompiler = { options: {} };
    webpack({ provider: 'tailwind' }).apply(compiler);

    const rules = compiler.options?.module?.rules ?? [];
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

  it('apply() also accepts Next\'s BARE config object (no `.options`) — duck-typed', () => {
    // Next.js `webpack(config)` hands you the bare config: rules live directly under `config.module`.
    const bare: DomflaxWebpackCompiler = { module: { rules: [] } };
    expect(() => webpack({ provider: 'tailwind' }).apply(bare)).not.toThrow();

    const rules = bare.module?.rules ?? [];
    expect(rules).toHaveLength(1);
    const rule = rules[0] as { test: RegExp; enforce: string; use: { loader: string }[] };
    expect(rule.enforce).toBe('pre');
    expect(rule.test.test('App.tsx')).toBe(true);
    expect(rule.use[0]?.loader).toMatch(/webpack-loader\.cjs$/);
  });

  it('apply() creates `module.rules` on a bare config that lacks them', () => {
    const bare: DomflaxWebpackCompiler = {};
    webpack().apply(bare);
    expect(bare.module?.rules).toHaveLength(1);
  });

  it('apply() preserves any pre-existing module rules', () => {
    const existing = { test: /\.css$/ };
    const compiler: DomflaxWebpackCompiler = { options: { module: { rules: [existing] } } };
    webpack().apply(compiler);

    expect(compiler.options?.module?.rules).toContain(existing);
    expect(compiler.options?.module?.rules).toHaveLength(2);
  });
});

/* ─────────────────────────────── default export (T7) ─────────────────────────────── */

describe('domflax default export', () => {
  it('is an object exposing createDomflax / vite / webpack', () => {
    expect(typeof domflax).toBe('object');
    expect(typeof domflax.createDomflax).toBe('function');
    expect(typeof domflax.vite).toBe('function');
    expect(typeof domflax.webpack).toBe('function');
    // The default-export members are the same functions as the named exports.
    expect(domflax.createDomflax).toBe(createDomflax);
    expect(domflax.vite).toBe(vite);
    expect(domflax.webpack).toBe(webpack);
  });

  it('domflax.vite() returns a valid Vite plugin shape', () => {
    const plugin = domflax.vite();
    expect(plugin.name).toBe('domflax');
    expect(plugin.enforce).toBe('pre');
    expect(typeof plugin.transform).toBe('function');
  });

  it('domflax.webpack() returns a valid webpack plugin shape', () => {
    const plugin = domflax.webpack();
    expect(plugin.name).toBe('domflax');
    expect(typeof plugin.apply).toBe('function');
  });
});
