import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createTransform } from '../src/transform';
import { parseInvocation, shouldPrompt } from '../src/options';
import { destinationFor, planWrites, type WritePlan } from '../src/safety';
import type { CliOptions } from '../src/options';

/* ───────────────────────── parseInvocation ───────────────────────── */

describe('parseInvocation', () => {
  it('parses a folder run with --out, --provider and --dry-run', () => {
    const o = parseInvocation(['src', '--out', 'build', '--provider', 'tailwind', '--dry-run']);
    expect(o.paths).toEqual(['src']);
    expect(o.out).toBe('build');
    expect(o.provider).toBe('tailwind');
    expect(o.dryRun).toBe(true);
    expect(o.report).toBe(false);
    expect(o.interactive).toBe(true);
    expect(o.passes).toBeNull();
  });

  it('collects repeated --css and the custom provider with --report', () => {
    const o = parseInvocation(['--provider', 'custom', '--css', 'a.css', '--css', 'b.css', '--report']);
    expect(o.provider).toBe('custom');
    expect(o.css).toEqual(['a.css', 'b.css']);
    expect(o.report).toBe(true);
    expect(o.paths).toEqual([]);
  });

  it('treats --yes (and --no-interactive) as opting out of the wizard', () => {
    expect(parseInvocation(['x', '--yes']).interactive).toBe(false);
    expect(parseInvocation(['x', '--no-interactive']).interactive).toBe(false);
  });

  it('parses the danger flags', () => {
    const o = parseInvocation(['app.tsx', '--dangerously-overwrite-source', '--no-git-check']);
    expect(o.dangerouslyOverwriteSource).toBe(true);
    expect(o.noGitCheck).toBe(true);
  });

  it('rejects an unknown provider', () => {
    expect(() => parseInvocation(['--provider', 'bogus'])).toThrow(/unknown --provider/);
  });
});

/* ───────────────────────── transform (dry-run flatten) ───────────────────────── */

describe('createTransform — conservative by default (verify off)', () => {
  it('does NOT flatten a flex-centering wrapper, but still compresses the child', () => {
    const code =
      '<div className="w-full h-full flex justify-center items-center">' +
      '<div className="h-10 w-10 bg-red-200">Hello</div>' +
      '</div>';

    const opts = parseInvocation(['App.tsx', '--dry-run']);
    const { transformFile } = createTransform(opts);
    const result = transformFile(code, 'App.tsx');

    expect(result.passthrough).toBe(false);
    // The module still changed — the child's h-10 w-10 compressed to size-10.
    expect(result.changed).toBe(true);
    expect(result.code).toContain('size-10');
    // … but the flex wrapper is PRESERVED (verify off never changes rendering).
    expect(result.code).toContain('justify-center');
    expect(result.code).not.toContain('place-self-center');
    expect(result.code).toContain('bg-red-200');
    expect(result.code).toContain('Hello');
  });

  it('round-trips a FULL module: keeps import/export/function/{title}, compresses the dynamic-child div, no flatten', () => {
    const code = [
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

    const { transformFile } = createTransform(parseInvocation(['Card.tsx', '--dry-run']));
    const result = transformFile(code, 'Card.tsx');

    expect(result.passthrough).toBe(false);
    expect(result.changed).toBe(true);

    // surrounding module survives (the regression: the backend used to drop ALL of this) …
    expect(result.code).toContain("import React from 'react';");
    expect(result.code).toContain('export default function Card({ title })');
    expect(result.code).toContain('return (');
    expect(result.code).toContain('{title}');

    // … the flex wrapper is PRESERVED (conservative); the dynamic-child `{title}` div is NOT
    //     flattened, but its OWN classes still COMPRESS (px-4 py-4 → p-4) — a dynamic child only
    //     blocks flatten, never a class-only compress.
    expect(result.code).toContain('justify-center');
    expect(result.code).not.toContain('place-self-center');
    expect(result.code).toContain('p-4');
    expect(result.code).not.toContain('px-4');
    expect(result.code).not.toContain('py-4');
    expect(result.code).toContain('bg-white');
  });

  it('passes through non-jsx/tsx files unchanged', () => {
    const css = '.x { color: red }';
    const { transformFile } = createTransform(parseInvocation(['styles.css']));
    const result = transformFile(css, 'styles.css');
    expect(result.passthrough).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.code).toBe(css);
  });
});

/* ───────────────────────── output safety (Q16) ───────────────────────── */

describe('output safety', () => {
  it('refuses to overwrite source when the out-dir destination resolves onto the source file', () => {
    const root = path.resolve('src');
    const file = path.join(root, 'App.tsx');
    const plan: WritePlan = { mode: 'out-dir', outDir: root };

    const dest = destinationFor(file, root, plan);
    expect(dest.ok).toBe(false);
    if (!dest.ok) expect(dest.error).toMatch(/refusing to overwrite source/);
  });

  it('writes to a mirrored out dir that does not collide with source', () => {
    const root = path.resolve('src');
    const file = path.join(root, 'a', 'App.tsx');
    const plan: WritePlan = { mode: 'out-dir', outDir: path.resolve('domflax-out') };

    const dest = destinationFor(file, root, plan);
    expect(dest.ok).toBe(true);
    if (dest.ok) expect(dest.value).toBe(path.resolve('domflax-out', 'a', 'App.tsx'));
  });

  it('allows in-place overwrite inside a disposable build dir even without the danger flag', () => {
    const root = path.resolve('dist');
    const file = path.join(root, 'App.tsx');
    const plan: WritePlan = { mode: 'out-dir', outDir: root };
    const dest = destinationFor(file, root, plan);
    expect(dest.ok).toBe(true);
  });

  it('gates --dangerously-overwrite-source on a clean git tree', () => {
    const base = parseInvocation(['src', '--dangerously-overwrite-source']);
    expect(planWrites(base, /* gitClean */ false).ok).toBe(false);
    expect(planWrites(base, /* gitClean */ true).ok).toBe(true);

    const waived: CliOptions = { ...base, noGitCheck: true };
    expect(planWrites(waived, /* gitClean */ false).ok).toBe(true);
  });
});

/* ───────────────────────── wizard gating (Q17) ───────────────────────── */

describe('shouldPrompt', () => {
  it('never prompts when not a TTY (would hang CI)', () => {
    const o = parseInvocation([]);
    expect(shouldPrompt(o, /* isTty */ false)).toBe(false);
  });

  it('prompts only for a no-args interactive TTY run', () => {
    expect(shouldPrompt(parseInvocation([]), true)).toBe(true);
    expect(shouldPrompt(parseInvocation(['src']), true)).toBe(false); // has a positional
    expect(shouldPrompt(parseInvocation(['--yes']), true)).toBe(false); // opted out
  });
});
