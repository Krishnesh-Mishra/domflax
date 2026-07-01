/**
 * @domflax/resolver-tailwind — Tailwind v4 END-TO-END resolution against a REAL v4 project.
 *
 * The v4 path drives the project's actual design system through the synchronous bridge, so it needs a
 * real v4 install (`tailwindcss` v4 + `@tailwindcss/node`). We look for one at a known local app and
 * otherwise SKIP — the suite stays green on machines without a v4 project. When present, it asserts
 * the high-value guarantees: common utilities resolve to real declarations, junk is `unknown`, a
 * combinator utility is opaque (preserved), and a v4 project is NOT flagged `unsupportedMajor`.
 */

import { createRequire } from 'node:module';
import * as path from 'node:path';

import type { CssProperty, StyleMap } from '@domflax/core';
import { BASE_CONDITION, conditionKey } from '@domflax/core';
import { normalizer } from '@domflax/pattern-kit';
import { describe, it, expect } from 'vitest';

import { createTailwindResolver } from '../src/index';

/** Find a local project whose `tailwindcss` is v4 and that also has `@tailwindcss/node`. */
function findV4Project(): string | null {
  const candidates = [
    'C:/Users/Krishnesh/dev/MonoRepo-SaaS/apps/saas-frontend',
    process.env.DOMFLAX_TW4_PROJECT ?? '',
  ].filter((p) => p.length > 0);
  for (const root of candidates) {
    try {
      const req = createRequire(path.join(root, '_.js'));
      const { version } = req('tailwindcss/package.json') as { version: string };
      if (!/^\s*4/.test(version)) continue;
      req.resolve('@tailwindcss/node');
      return root;
    } catch {
      /* not this one */
    }
  }
  return null;
}

const projectRoot = findV4Project();
const base = (sm: StyleMap) => sm.blocks.get(conditionKey(BASE_CONDITION));
const val = (sm: StyleMap, prop: string) => base(sm)?.decls.get(prop as CssProperty)?.value;

describe.skipIf(projectRoot === null)('Tailwind v4 — real design-system resolution', () => {
  const root = projectRoot as string;

  it('resolves a v4 project (not flagged unsupported) and forward-resolves common utilities', () => {
    const resolver = createTailwindResolver({ projectRoot: root }) as unknown as {
      unsupportedMajor: number | null;
      provider: string;
      resolve: ReturnType<typeof createTailwindResolver>['resolve'];
    };
    expect(resolver.unsupportedMajor).toBeNull();
    expect(resolver.provider).toMatch(/^tailwindcss@4\./);

    const { styles, resolved, unknown } = resolver.resolve({
      classes: ['px-4', 'py-4', 'h-10', 'w-10', 'bg-white', 'flex', 'totally-made-up-xyz'],
    });

    // Every known utility resolved; only the junk token is unknown (⇒ preserved).
    expect(resolved).toEqual(['px-4', 'py-4', 'h-10', 'w-10', 'bg-white', 'flex']);
    expect(unknown).toEqual(['totally-made-up-xyz']);

    // Real declarations are seen (v4 keeps theme values as var()/calc() — that is fine, it is a real,
    // non-empty computed style, so a `bg-white` box is never treated as inert).
    expect(val(styles, 'display')).toBe('flex');
    expect(val(styles, 'background-color')).toBe('var(--color-white)');
    // v4 `px-4`/`py-4` emit the LOGICAL `padding-inline`/`padding-block`; the shared normalizer folds
    // their (direction-independent) single value down to the physical side longhands, so `p-4` (also
    // physical) can reconcile with `px-4 py-4` during compress on v4 exactly as it does on v3.
    expect(val(styles, 'padding-left')).toBe('calc(var(--spacing) * 4)');
    expect(val(styles, 'padding-right')).toBe('calc(var(--spacing) * 4)');
    expect(val(styles, 'padding-top')).toBe('calc(var(--spacing) * 4)');
    expect(val(styles, 'padding-bottom')).toBe('calc(var(--spacing) * 4)');
    expect(val(styles, 'height')).toBe('calc(var(--spacing) * 10)');
    expect(val(styles, 'width')).toBe('calc(var(--spacing) * 10)');
  }, 60_000);

  it('surfaces a combinator utility as opaque (preserved), not inert', () => {
    const resolver = createTailwindResolver({ projectRoot: root });
    const { opaque, unknown, styles } = resolver.resolve({ classes: ['space-x-4'] });
    expect(unknown).toEqual([]); // the engine knows it
    expect(opaque.some((o) => o.token === 'space-x-4')).toBe(true);
    expect(base(styles)).toBeUndefined(); // nothing leaked onto the element's own box
  }, 60_000);

  it('owns known utilities and rejects junk', () => {
    const resolver = createTailwindResolver({ projectRoot: root });
    expect(resolver.owns('flex')).toBe(true);
    expect(resolver.owns('bg-white')).toBe(true);
    expect(resolver.owns('totally-made-up-xyz')).toBe(false);
    expect(resolver.owns('')).toBe(false);
  }, 60_000);

  it('reverse-emits computed styles back to v4 utilities (round-trip is exact)', () => {
    const resolver = createTailwindResolver({ projectRoot: root });
    const { styles } = resolver.resolve({ classes: ['h-10', 'w-10', 'bg-white', 'flex'] });
    const sink = { register: () => '', drain: () => [] };
    const { classes, exact } = resolver.emit(styles, { normalizer, sink });

    expect(classes.length).toBeGreaterThan(0);
    // Re-resolving the emitted classes reproduces the original BASE declarations.
    const round = resolver.resolve({ classes });
    expect(val(round.styles, 'display')).toBe('flex');
    expect(val(round.styles, 'background-color')).toBe('var(--color-white)');
    expect(val(round.styles, 'height')).toBe('calc(var(--spacing) * 10)');
    expect(val(round.styles, 'width')).toBe('calc(var(--spacing) * 10)');
    expect(exact).toBe(true);
  }, 60_000);
});
