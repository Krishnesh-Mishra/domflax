import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseInvocation } from '../src/options';
import { createTransform } from '../src/transform';

/**
 * FEATURE A — an HTML file resolves against its OWN `<link>` imports (plus the global `--css`). The
 * discriminator is FLATTEN behaviour: a wrapper whose class the resolver KNOWS to be load-bearing
 * (padding, or a combinator subject) is PRESERVED; an UNKNOWN class resolves to nothing, making the
 * wrapper look styleless — so it would be flattened away. Preservation therefore proves the local sheet
 * was actually applied.
 */
describe('per-file HTML CSS (custom provider)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'domflax-perfile-'));
    writeFileSync(path.join(dir, 'local.css'), '.pad{padding:1rem}\n');
    writeFileSync(path.join(dir, 'global.css'), '.pad{padding:1rem}\n');
    // `.keep` has no rule of its own but is the subject of a combinator selector → load-bearing.
    writeFileSync(path.join(dir, 'selector.css'), '.child{color:red}\n.keep > .child{font-weight:bold}\n');
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const page = (links: string, body: string) =>
    `<!doctype html><html><head>${links}</head><body>${body}</body></html>`;
  const padWrap = '<div class="pad"><a class="link">L</a></div>';
  const keepWrap = '<div class="keep"><span class="child">y</span></div>';

  it('resolves against the file’s own <link> (NOT in --css): a padded wrapper is preserved', () => {
    const code = page('<link rel="stylesheet" href="./local.css">', padWrap);
    const { transformFile } = createTransform(parseInvocation(['--provider', 'custom'])); // no --css
    const out = transformFile(code, path.join(dir, 'page.html')).code;
    expect(out).toContain('class="pad"'); // padding known → wrapper kept
    expect(out).toContain('class="link"');
  });

  it('honors selector-safety from the file’s own <link>: a combinator subject wrapper is preserved', () => {
    const code = page('<link rel="stylesheet" href="./selector.css">', keepWrap);
    const { transformFile } = createTransform(parseInvocation(['--provider', 'custom']));
    const out = transformFile(code, path.join(dir, 'page.html')).code;
    expect(out).toContain('class="keep"'); // `.keep > .child` depends on it → not flattened
    expect(out).toContain('class="child"');
  });

  it('ignores a remote <link>: the class is unknown, so the styleless wrapper is flattened away', () => {
    const code = page('<link rel="stylesheet" href="https://cdn.example.com/local.css">', padWrap);
    const { transformFile } = createTransform(parseInvocation(['--provider', 'custom']));
    const out = transformFile(code, path.join(dir, 'page.html')).code;
    expect(out).not.toContain('class="pad"'); // remote skipped → unknown → wrapper removed
    expect(out).toContain('class="link"');
  });

  it('applies the GLOBAL --css to every file even with no local <link>', () => {
    const code = page('', padWrap);
    const opts = parseInvocation(['--provider', 'custom', '--css', path.join(dir, 'global.css')]);
    const out = createTransform(opts).transformFile(code, path.join(dir, 'page.html')).code;
    expect(out).toContain('class="pad"'); // global sheet knows `.pad` → wrapper kept
  });

  it('two files sharing the same local import both resolve against it (cached resolver reuse)', () => {
    const code = page('<link rel="stylesheet" href="./local.css">', padWrap);
    const { transformFile } = createTransform(parseInvocation(['--provider', 'custom']));
    const a = transformFile(code, path.join(dir, 'a.html')).code;
    const b = transformFile(code, path.join(dir, 'b.html')).code;
    expect(a).toContain('class="pad"');
    expect(b).toContain('class="pad"');
  });
});
