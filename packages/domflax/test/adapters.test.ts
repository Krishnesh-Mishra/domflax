import { describe, it, expect, vi, afterEach } from 'vitest';

import domflax, {
  createDomflax,
  vite,
  webpack,
  type DomflaxTransformResult,
  type DomflaxWebpackCompiler,
} from '../src/index';
import { accumulateOnCompilation, type FileStatDelta } from '../src/summary';

/** Shorthand delta builder (BEFORE totals default to generous non-zero values). */
const delta = (nodesRemoved: number, classesSaved: number, bytesSaved: number): FileStatDelta => ({
  nodesBefore: nodesRemoved + 10,
  nodesRemoved,
  classesSaved,
  bytesBefore: Math.abs(bytesSaved) + 1000,
  bytesSaved,
});

/** Narrow vite's sync (verify-off) transform result for assertions. */
function sync(r: DomflaxTransformResult | null | Promise<DomflaxTransformResult | null>): DomflaxTransformResult | null {
  expect(r).not.toBeInstanceOf(Promise);
  return r as DomflaxTransformResult | null;
}

/* ─────────────────────────────── vite() adapter ─────────────────────────────── */

describe('domflax.vite()', () => {
  it('returns a Vite plugin shape (name / enforce / transform)', () => {
    const plugin = vite();
    expect(plugin.name).toBe('domflax');
    expect(plugin.enforce).toBe('pre');
    expect(typeof plugin.transform).toBe('function');
  });

  it('transform compresses a .tsx module conservatively (verify off keeps the wrapper)', () => {
    const code =
      '<div className="w-full h-full flex justify-center items-center">' +
      '<div className="h-10 w-10 bg-red-200">Hello</div>' +
      '</div>';

    const result = sync(vite().transform(code, 'App.tsx'));

    expect(result).not.toBeNull();
    // Vite TransformResult: { code, map }. The flex wrapper is PRESERVED (no rendering change) …
    expect(result?.code).toContain('justify-center');
    expect(result?.code).not.toContain('place-self-center');
    // … while the child still compresses (h-10 w-10 → size-10) so the module did change.
    expect(result?.code).toContain('size-10');
    expect(result?.code).toContain('bg-red-200');
    expect(result?.map ?? null).toBeNull();
  });

  it('transform strips query suffixes before matching (e.g. App.tsx?used)', () => {
    const code =
      '<div className="w-full h-full flex justify-center items-center">' +
      '<div className="h-10 w-10 bg-red-200">Hello</div>' +
      '</div>';

    const result = sync(vite().transform(code, 'App.tsx?used'));
    expect(result).not.toBeNull();
    expect(result?.code).toContain('size-10');
  });

  it('transform returns null for an unchanged .tsx module', () => {
    expect(vite().transform('<div>Hello</div>', 'App.tsx')).toBeNull();
  });

  it('transform returns null for a non-jsx/tsx module', () => {
    expect(vite().transform('.x { color: red }', 'styles.css')).toBeNull();
  });

  it('per-file transform result carries a stats delta (zero for unchanged)', () => {
    const changed = createDomflax().transform(
      '<div className="h-10 w-10 bg-red-200">Hello</div>',
      'App.tsx',
    );
    expect(changed.stats.bytesSaved).toBeGreaterThan(0);
    expect(changed.stats.classesSaved).toBeGreaterThanOrEqual(1);
    // BEFORE totals (audit denominators) are carried alongside the deltas.
    expect(changed.stats.nodesBefore).toBeGreaterThanOrEqual(1);
    expect(changed.stats.bytesBefore).toBeGreaterThan(0);

    const unchanged = createDomflax().transform('<div>Hello</div>', 'App.tsx');
    expect(unchanged.stats).toMatchObject({ nodesRemoved: 0, classesSaved: 0, bytesSaved: 0 });
    expect(unchanged.stats.bytesBefore).toBeGreaterThan(0);

    const unsupported = createDomflax().transform('.x { color: red }', 'styles.css');
    expect(unsupported.stats).toEqual({
      nodesBefore: 0,
      nodesRemoved: 0,
      classesSaved: 0,
      bytesBefore: 0,
      bytesSaved: 0,
    });
  });
});

/* ───────────────────── vite() build-end summary ───────────────────── */

describe('domflax.vite() build-end summary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('accumulates changed files and prints ONE summary at buildEnd', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const plugin = vite();

    plugin.buildStart();
    plugin.transform('<div className="h-10 w-10 bg-red-200">A</div>', 'A.tsx');
    plugin.transform('<div className="h-20 w-20 bg-blue-200">B</div>', 'B.tsx');
    plugin.transform('<div>unchanged</div>', 'C.tsx'); // no change → not counted
    expect(write).not.toHaveBeenCalled(); // quiet during the build

    plugin.buildEnd();
    expect(write).toHaveBeenCalledTimes(1);
    const printed = String(write.mock.calls[0]![0]);
    expect(printed).toContain('▲ domflax');
    expect(printed).toContain('files optimized');
    expect(printed).toContain('2'); // two files changed

    // closeBundle must not double-print.
    plugin.closeBundle();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('stays silent when no file changed', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const plugin = vite();
    plugin.buildStart();
    plugin.transform('<div>Hello</div>', 'App.tsx');
    plugin.buildEnd();
    expect(write).not.toHaveBeenCalled();
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

/* ─────────────────── webpack build-end summary (loader ↔ plugin bridge) ─────────────────── */

describe('domflax.webpack() build-end summary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('taps done on a real Compiler and prints the loader-accumulated totals', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    // Stub a real webpack Compiler: capture whatever the plugin taps onto `hooks.done`.
    let doneCb: ((arg: unknown) => void) | null = null;
    const compiler: DomflaxWebpackCompiler = {
      options: {},
      hooks: { done: { tap: (_name, fn) => { doneCb = fn; } } },
    };

    webpack({ provider: 'tailwind' }).apply(compiler);
    expect(typeof doneCb).toBe('function');

    // Simulate the loader (separate bundle) writing per-file stats onto the compilation.
    const compilation: Record<string | symbol, unknown> = {};
    accumulateOnCompilation(compilation, delta(12, 5, 300), true);
    accumulateOnCompilation(compilation, delta(3, 1, 40), true);

    // webpack fires `done` with a Stats object exposing `.compilation`.
    doneCb!({ compilation });

    expect(write).toHaveBeenCalledTimes(1);
    const printed = String(write.mock.calls[0]![0]);
    expect(printed).toContain('▲ domflax');
    expect(printed).toContain('2'); // two changed files
    expect(printed).toContain('15'); // 12 + 3 nodes
    expect(printed).toContain('340 B'); // 300 + 40 bytes
  });

  it('registers a child plugin on a bare Next config that taps done on the real Compiler', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    // Next hands `apply` the bare config (no `hooks`); the plugin must defer via `config.plugins`.
    const bare: DomflaxWebpackCompiler & { plugins?: { apply(c: unknown): void }[] } = { module: { rules: [] }, plugins: [] };
    webpack().apply(bare);
    expect(bare.plugins).toHaveLength(1);

    // webpack later runs the child plugin's apply with the real Compiler.
    let doneCb: ((arg: unknown) => void) | null = null;
    const realCompiler = { hooks: { done: { tap: (_n: string, fn: (a: unknown) => void) => { doneCb = fn; } } } };
    bare.plugins![0]!.apply(realCompiler);
    expect(typeof doneCb).toBe('function');

    const compilation: Record<string | symbol, unknown> = {};
    accumulateOnCompilation(compilation, delta(1, 1, 10), true);
    doneCb!({ compilation });
    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0]![0])).toContain('files optimized');
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
