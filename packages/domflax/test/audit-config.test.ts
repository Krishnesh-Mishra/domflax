import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import domflax, { createDomflax, defineConfig, vite, webpack } from '../src/index';
import type { DomflaxConfig, DomflaxWebpackCompiler } from '../src/index';
import { accumulateAuditOnCompilation, printCompilationAudit } from '../src/audit-bridge';
import domflaxLoader from '../src/webpack-loader';
import type { DomflaxLoaderContext } from '../src/webpack-loader';

const COMPRESSIBLE =
  'export default function A(){return (<div className="px-4 py-4 bg-white">hi</div>);}\n';

/* ─────────────────────────────── shared config type + defineConfig ─────────────────────────────── */

describe('DomflaxConfig / defineConfig (root exports)', () => {
  it('defineConfig is re-exported from the domflax root and is the identity', () => {
    const config: DomflaxConfig = { provider: 'tailwind', audit: true, out: 'x' };
    expect(defineConfig(config)).toBe(config);
    expect(typeof defineConfig).toBe('function');
  });

  it('a DomflaxConfig object is valid inline plugin options (typed shared config)', () => {
    const shared: DomflaxConfig = { provider: 'tailwind', safety: 1 };
    // Compile-time: DomflaxOptions extends DomflaxConfig, so spreading a config is type-safe.
    const plugin = vite({ ...shared, configFile: false });
    expect(plugin.name).toBe('domflax');
    const engine = createDomflax({ ...shared, configFile: false });
    expect(engine.options.provider).toBe('tailwind');
    expect(engine.options.safety).toBe(1);
  });
});

/* ─────────────────────────────── config-file merge in the adapters ─────────────────────────────── */

describe('adapter config-file merge (inline > file > defaults)', () => {
  let dir: string;
  let cfgPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'domflax-adapter-config-'));
    cfgPath = path.join(dir, 'domflax.config.json');
    writeFileSync(cfgPath, JSON.stringify({ provider: 'custom', cssFiles: ['a.css'], safety: 1 }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('createDomflax merges an explicit configFile path underneath inline options', () => {
    const fromFile = createDomflax({ configFile: cfgPath });
    expect(fromFile.options.provider).toBe('custom');
    expect(fromFile.options.cssFiles).toEqual(['a.css']);
    expect(fromFile.options.safety).toBe(1);

    // Inline wins over the file.
    const overridden = createDomflax({ configFile: cfgPath, provider: 'tailwind' });
    expect(overridden.options.provider).toBe('tailwind');
    expect(overridden.options.safety).toBe(1); // still from the file
  });

  it('discovers the config upward from projectRoot (nearest wins)', () => {
    const engine = createDomflax({ projectRoot: dir });
    expect(engine.options.provider).toBe('custom');
  });

  it('configFile: false disables discovery entirely', () => {
    const engine = createDomflax({ projectRoot: dir, configFile: false });
    expect(engine.options.provider).toBe('auto'); // default, file ignored
  });

  it('webpack() forwards the MERGED options to the loader rule', () => {
    const compiler: DomflaxWebpackCompiler = { options: {} };
    webpack({ configFile: cfgPath, provider: 'tailwind' }).apply(compiler);
    const rule = compiler.options?.module?.rules?.[0] as {
      use: { options: { provider?: string; safety?: number; configFile?: unknown } }[];
    };
    expect(rule.use[0]!.options.provider).toBe('tailwind'); // inline won
    expect(rule.use[0]!.options.safety).toBe(1); // from the file
    expect(rule.use[0]!.options.configFile).toBe(false); // loader must not re-discover
  });
});

/* ─────────────────────────────── vite() audit mode ─────────────────────────────── */

describe('domflax.vite() audit mode', () => {
  afterEach(() => vi.restoreAllMocks());

  it('passes every module through UNCHANGED and prints the audit box at buildEnd', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const plugin = vite({ audit: true, configFile: false });

    plugin.buildStart();
    // A compressible module: a real run WOULD change it — audit must still pass it through.
    expect(plugin.transform(COMPRESSIBLE, 'A.tsx')).toBeNull();
    expect(plugin.transform('<div>unchanged</div>', 'C.tsx')).toBeNull();
    expect(plugin.transform('.x{}', 'styles.css')).toBeNull(); // unsupported → ignored
    expect(write).not.toHaveBeenCalled(); // quiet during the build

    plugin.buildEnd();
    expect(write).toHaveBeenCalledTimes(1);
    const printed = String(write.mock.calls[0]![0]);
    expect(printed).toContain('▲ domflax audit');
    expect(printed).toContain('DOM efficiency score');
    expect(printed).toContain('files analyzed');
    expect(printed).toContain('top files by savable bytes');
    expect(printed).toContain('A.tsx'); // the improvable module is listed
    expect(printed).not.toContain('files optimized'); // audit REPLACES the normal summary

    // closeBundle must not double-print; buildStart resets for the next watch rebuild.
    plugin.closeBundle();
    expect(write).toHaveBeenCalledTimes(1);
    plugin.buildStart();
    plugin.buildEnd(); // nothing analyzed in this "rebuild" → silent
    expect(write).toHaveBeenCalledTimes(1);
  });
});

/* ─────────────────────────────── webpack audit (loader ↔ plugin bridge) ─────────────────────────────── */

describe('domflax.webpack() audit mode', () => {
  afterEach(() => vi.restoreAllMocks());

  it('the loader passes the module through unchanged and stashes audit stats', () => {
    const compilation: Record<string | symbol, unknown> = {};
    const ctx: DomflaxLoaderContext = {
      resourcePath: 'A.tsx',
      getOptions: () => ({ audit: true, configFile: false }),
      _compilation: compilation,
    };
    const out = domflaxLoader.call(ctx, COMPRESSIBLE);
    expect(out).toBe(COMPRESSIBLE); // byte-identical passthrough

    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    printCompilationAudit(compilation);
    expect(write).toHaveBeenCalledTimes(1);
    const printed = String(write.mock.calls[0]![0]);
    expect(printed).toContain('▲ domflax audit');
    expect(printed).toContain('A.tsx');

    // Once-latch: a second print is suppressed.
    printCompilationAudit(compilation);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('the done hook prints the audit box instead of the summary when audit is on', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let doneCb: ((arg: unknown) => void) | null = null;
    const compiler: DomflaxWebpackCompiler = {
      options: {},
      hooks: { done: { tap: (_n, fn) => { doneCb = fn; } } },
    };
    webpack({ audit: true, configFile: false }).apply(compiler);
    expect(typeof doneCb).toBe('function');

    const compilation: Record<string | symbol, unknown> = {};
    accumulateAuditOnCompilation(compilation, 'src/App.tsx', {
      nodesBefore: 50,
      nodesRemoved: 5,
      classesSaved: 8,
      bytesBefore: 2000,
      bytesSaved: 200,
    });
    doneCb!({ compilation });

    expect(write).toHaveBeenCalledTimes(1);
    const printed = String(write.mock.calls[0]![0]);
    expect(printed).toContain('▲ domflax audit');
    expect(printed).toContain('src/App.tsx');
    expect(printed).not.toContain('files optimized');
  });
});

/* ─────────────────────────────── default export still intact ─────────────────────────────── */

describe('default export after the 0.3.0 split', () => {
  it('still exposes createDomflax / vite / webpack (same functions as named exports)', () => {
    expect(domflax.createDomflax).toBe(createDomflax);
    expect(domflax.vite).toBe(vite);
    expect(domflax.webpack).toBe(webpack);
  });
});
