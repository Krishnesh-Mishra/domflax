import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cssSetKey, extractHtmlStylesheets } from '../src/html-css';

/* ───────────────────────── extractHtmlStylesheets ───────────────────────── */

describe('extractHtmlStylesheets', () => {
  let dir: string;
  let localCss: string;
  let nestedCss: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'domflax-htmlcss-'));
    localCss = path.join(dir, 'local.css');
    nestedCss = path.join(dir, 'css', 'theme.css');
    writeFileSync(localCss, '.a{color:red}');
    mkdtempSync(path.join(tmpdir(), 'unused-')); // noise
    writeFileSync(path.join(dir, 'ignore.css'), '.b{color:blue}');
    // nested dir
    const cssDir = path.join(dir, 'css');
    require('node:fs').mkdirSync(cssDir, { recursive: true });
    writeFileSync(nestedCss, '.t{color:green}');
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('resolves local <link rel="stylesheet"> hrefs relative to the html file, keeping only existing files', () => {
    const html = [
      '<!doctype html><html><head>',
      '<link rel="stylesheet" href="./local.css">',
      '<link rel="stylesheet" href="css/theme.css?v=3">', // query stripped, nested
      '<link rel="stylesheet" href="./missing.css">', // dropped (does not exist)
      '</head><body></body></html>',
    ].join('\n');
    const htmlPath = path.join(dir, 'page.html');

    const { files, inline } = extractHtmlStylesheets(html, htmlPath);
    expect(files).toContain(localCss);
    expect(files).toContain(path.resolve(nestedCss));
    expect(files.some((f) => f.endsWith('missing.css'))).toBe(false);
    expect(inline).toEqual([]);
  });

  it('ignores remote, protocol-relative, and data: hrefs', () => {
    const html = [
      '<link rel="stylesheet" href="https://cdn.example.com/x.css">',
      '<link rel="stylesheet" href="//cdn.example.com/y.css">',
      '<link rel="stylesheet" href="data:text/css,.z{}">',
      '<link rel="stylesheet" href="./local.css">',
    ].join('\n');
    const { files } = extractHtmlStylesheets(html, path.join(dir, 'page.html'));
    expect(files).toEqual([localCss]);
  });

  it('ignores <link> without a stylesheet rel (preload, icon, …)', () => {
    const html =
      '<link rel="preload" href="./local.css" as="style">' +
      '<link rel="icon" href="./local.css">';
    const { files } = extractHtmlStylesheets(html, path.join(dir, 'page.html'));
    expect(files).toEqual([]);
  });

  it('captures inline <style> blocks and skips non-CSS style types', () => {
    const html =
      '<style>.inline{margin:0}</style>' +
      '<style type="text/scss">$x: 1;</style>' +
      '<style type="text/css">.k{padding:0}</style>';
    const { inline } = extractHtmlStylesheets(html, path.join(dir, 'page.html'));
    expect(inline).toEqual(['.inline{margin:0}', '.k{padding:0}']);
  });
});

/* ───────────────────────── cssSetKey (resolver-cache reuse) ───────────────────────── */

describe('cssSetKey', () => {
  it('is stable for the same set (two pages sharing imports reuse one resolver)', () => {
    const a = cssSetKey(['/x/a.css', '/x/b.css'], ['.i{}']);
    const b = cssSetKey(['/x/a.css', '/x/b.css'], ['.i{}']);
    expect(a).toBe(b);
  });

  it('changes when the path set or inline content changes', () => {
    const base = cssSetKey(['/x/a.css'], []);
    expect(cssSetKey(['/x/a.css', '/x/b.css'], [])).not.toBe(base);
    expect(cssSetKey(['/x/a.css'], ['.i{}'])).not.toBe(base);
  });
});
