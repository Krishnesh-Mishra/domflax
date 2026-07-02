import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONFIG_FILE_NAMES,
  defineConfig,
  discoverConfig,
  findConfigFile,
  loadConfigFileSync,
} from '../src/config-file';
import type { DomflaxConfig } from '../src/config-file';
import { parseInvocation } from '../src/options';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'domflax-config-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/* ───────────────────────── defineConfig ───────────────────────── */

describe('defineConfig', () => {
  it('is the identity function (IntelliSense only)', () => {
    const config: DomflaxConfig = { provider: 'tailwind', safety: 1 };
    expect(defineConfig(config)).toBe(config);
  });
});

/* ───────────────────────── discovery ───────────────────────── */

describe('findConfigFile', () => {
  it('finds a config in the starting directory', () => {
    const file = path.join(dir, 'domflax.config.json');
    writeFileSync(file, '{}');
    expect(findConfigFile(dir)).toBe(file);
  });

  it('walks upward and the NEAREST file wins', () => {
    const parentCfg = path.join(dir, 'domflax.config.json');
    writeFileSync(parentCfg, '{"provider":"tailwind"}');
    const child = path.join(dir, 'a', 'b');
    mkdirSync(child, { recursive: true });
    // From the grandchild (no config of its own, no package.json boundary) → the parent's file.
    expect(findConfigFile(child)).toBe(parentCfg);

    // A nearer config shadows the parent's.
    const childCfg = path.join(child, 'domflax.config.json');
    writeFileSync(childCfg, '{"provider":"custom"}');
    expect(findConfigFile(child)).toBe(childCfg);
  });

  it('prefers .js over .mjs/.cjs/.json within one directory (lookup order)', () => {
    expect([...CONFIG_FILE_NAMES]).toEqual([
      'domflax.config.js',
      'domflax.config.mjs',
      'domflax.config.cjs',
      'domflax.config.json',
    ]);
    writeFileSync(path.join(dir, 'domflax.config.json'), '{}');
    writeFileSync(path.join(dir, 'domflax.config.cjs'), 'module.exports = {};');
    expect(findConfigFile(dir)).toBe(path.join(dir, 'domflax.config.cjs'));
  });

  it('stops at a package.json boundary (never escapes the project)', () => {
    // Config OUTSIDE the project must not be picked up from inside it.
    writeFileSync(path.join(dir, 'domflax.config.json'), '{"provider":"tailwind"}');
    const project = path.join(dir, 'project');
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, 'package.json'), '{"name":"p"}');
    expect(findConfigFile(project)).toBeNull();

    // … but a config SITTING NEXT TO the package.json is still found.
    const inside = path.join(project, 'domflax.config.json');
    writeFileSync(inside, '{}');
    expect(findConfigFile(project)).toBe(inside);
  });
});

/* ───────────────────────── loading ───────────────────────── */

describe('loadConfigFileSync', () => {
  it('loads a .json config', () => {
    const file = path.join(dir, 'domflax.config.json');
    writeFileSync(file, '{"provider":"custom","css":["a.css"],"safety":1}');
    expect(loadConfigFileSync(file)).toEqual({ provider: 'custom', css: ['a.css'], safety: 1 });
  });

  it('loads a .cjs config via module.exports', () => {
    const file = path.join(dir, 'domflax.config.cjs');
    writeFileSync(file, 'module.exports = { provider: "tailwind", maxMemory: 512 };');
    expect(loadConfigFileSync(file)).toEqual({ provider: 'tailwind', maxMemory: 512 });
  });

  it('loads a CommonJS .js config (no surrounding package.json ⇒ CJS)', () => {
    const file = path.join(dir, 'domflax.config.js');
    writeFileSync(file, 'module.exports = { out: "js-out", details: true };');
    expect(loadConfigFileSync(file)).toEqual({ out: 'js-out', details: true });
  });

  it('loads an ES-module .mjs config via export default', () => {
    const file = path.join(dir, 'domflax.config.mjs');
    writeFileSync(file, 'export default { provider: "custom", cssFiles: ["m.css"] };');
    expect(loadConfigFileSync(file)).toEqual({ provider: 'custom', cssFiles: ['m.css'] });
  });

  it('rejects a config that is not a plain object', () => {
    const file = path.join(dir, 'domflax.config.json');
    writeFileSync(file, '[1,2,3]');
    expect(() => loadConfigFileSync(file)).toThrow(/must export a plain object/);
  });

  it('throws a clear error for unparseable JSON', () => {
    const file = path.join(dir, 'domflax.config.json');
    writeFileSync(file, '{nope');
    expect(() => loadConfigFileSync(file)).toThrow(/cannot read config/);
  });

  it('discoverConfig combines find + load (null when nothing exists)', () => {
    expect(discoverConfig(dir)).toBeNull();
    const file = path.join(dir, 'domflax.config.json');
    writeFileSync(file, '{"report":true}');
    expect(discoverConfig(dir)).toEqual({ path: file, config: { report: true } });
  });
});

/* ───────────────────────── precedence: flags > file > defaults ───────────────────────── */

describe('parseInvocation with a file config', () => {
  it('explicit flags override the file; unset options fall back to the file', () => {
    const o = parseInvocation(['src', '--provider', 'tailwind', '--out', 'flag-out'], {
      provider: 'custom',
      out: 'cfg-out',
      report: true,
      safety: 1,
    });
    expect(o.provider).toBe('tailwind'); // flag wins
    expect(o.out).toBe('flag-out'); // flag wins
    expect(o.report).toBe(true); // from the file
    expect(o.safety).toBe(1); // from the file
  });

  it('the file fills everything the flags left unset (defaults last)', () => {
    const o = parseInvocation(['src'], {
      provider: 'custom',
      css: ['a.css'],
      dryRun: true,
      audit: true,
      details: true,
      maxMemory: 512,
      concurrency: 2,
      projectRoot: 'root',
      passes: ['compress/size'],
      out: 'cfg-out',
    });
    expect(o.provider).toBe('custom');
    expect(o.css).toEqual(['a.css']);
    expect(o.dryRun).toBe(true);
    expect(o.audit).toBe(true);
    expect(o.details).toBe(true);
    expect(o.maxMemory).toBe(512);
    expect(o.concurrency).toBe(2);
    expect(o.projectRoot).toBe('root');
    expect(o.passes).toEqual(['compress/size']);
    expect(o.out).toBe('cfg-out');
  });

  it('defaults still apply when neither flags nor file set an option', () => {
    const o = parseInvocation(['src'], {});
    expect(o.provider).toBe('auto');
    expect(o.safety).toBe(2);
    expect(o.dryRun).toBe(false);
    expect(o.audit).toBe(false);
    expect(o.out).toBeNull();
    expect(o.passes).toBeNull();
  });

  it('cssFiles (plugin spelling) is accepted as an alias of css', () => {
    expect(parseInvocation(['src'], { cssFiles: ['b.css'] }).css).toEqual(['b.css']);
    // The CLI spelling wins when both are present.
    expect(parseInvocation(['src'], { css: ['a.css'], cssFiles: ['b.css'] }).css).toEqual(['a.css']);
  });

  it('danger flags are NEVER configurable from a file', () => {
    const sneaky = { dangerouslyOverwriteSource: true, noGitCheck: true } as DomflaxConfig;
    const o = parseInvocation(['src'], sneaky);
    expect(o.dangerouslyOverwriteSource).toBe(false);
    expect(o.noGitCheck).toBe(false);
  });

  it('validates file values (provider / safety / positive ints)', () => {
    expect(() => parseInvocation(['src'], { provider: 'bogus' as never })).toThrow(/config file/);
    expect(() => parseInvocation(['src'], { safety: 9 as never })).toThrow(/"safety" in config file/);
    expect(() => parseInvocation(['src'], { maxMemory: -1 })).toThrow(/"maxMemory" in config file/);
    expect(() => parseInvocation(['src'], { concurrency: 1.5 })).toThrow(/"concurrency" in config file/);
  });
});
