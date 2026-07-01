import { describe, it, expect } from 'vitest';

import type { CssProperty, StyleMap } from '@domflax/core';
import { BASE_CONDITION, conditionKey } from '@domflax/core';
import { normalizer } from '@domflax/pattern-kit';

import { createTailwindResolver } from '../src/index';

const base = (sm: StyleMap) => sm.blocks.get(conditionKey(BASE_CONDITION));
const val = (sm: StyleMap, prop: string) => base(sm)?.decls.get(prop as CssProperty)?.value;

describe('createTailwindResolver — forward resolve (real tailwindcss engine)', () => {
  it('resolves flex + items-center + justify-center into the BASE condition block', () => {
    const resolver = createTailwindResolver();
    const { styles, resolved, unknown } = resolver.resolve({
      classes: ['flex', 'items-center', 'justify-center'],
    });

    expect(resolved).toEqual(['flex', 'items-center', 'justify-center']);
    expect(unknown).toEqual([]);

    expect(val(styles, 'display')).toBe('flex');
    expect(val(styles, 'align-items')).toBe('center');
    expect(val(styles, 'justify-content')).toBe('center');
  });

  it('resolves a broad spread of real utilities to correct declaration values', () => {
    const resolver = createTailwindResolver();
    const { styles, unknown } = resolver.resolve({
      classes: [
        'flex',
        'items-center',
        'justify-center',
        'p-4',
        'mx-auto',
        'text-sm',
        'bg-red-200',
        'w-full',
        'grid',
        'gap-2',
        'rounded-lg',
      ],
    });
    expect(unknown).toEqual([]);

    // display: the later `grid` overrides the earlier `flex` (equal-specificity cascade).
    expect(val(styles, 'display')).toBe('grid');
    expect(val(styles, 'align-items')).toBe('center');
    expect(val(styles, 'justify-content')).toBe('center');

    // p-4 → four padding sides, each 1rem (shorthand expanded by the shared normalizer).
    expect(val(styles, 'padding-top')).toBe('1rem');
    expect(val(styles, 'padding-right')).toBe('1rem');
    expect(val(styles, 'padding-bottom')).toBe('1rem');
    expect(val(styles, 'padding-left')).toBe('1rem');

    // mx-auto → margin-left / margin-right auto.
    expect(val(styles, 'margin-left')).toBe('auto');
    expect(val(styles, 'margin-right')).toBe('auto');

    // text-sm → font-size + line-height.
    expect(val(styles, 'font-size')).toBe('0.875rem');
    expect(val(styles, 'line-height')).toBe('1.25rem');

    // bg-red-200 → the real engine emits an opacity custom-property + a var-based color.
    expect(val(styles, '--tw-bg-opacity')).toBe('1');
    expect(val(styles, 'background-color')).toBe('rgb(254 202 202 / var(--tw-bg-opacity, 1))');

    // w-full → 100%.
    expect(val(styles, 'width')).toBe('100%');

    // gap-2 → row-gap + column-gap (0.5rem), expanded by the shared normalizer.
    expect(val(styles, 'row-gap')).toBe('0.5rem');
    expect(val(styles, 'column-gap')).toBe('0.5rem');

    // rounded-lg → border-radius, expanded to the four CORNER longhands by the shared normalizer.
    expect(val(styles, 'border-top-left-radius')).toBe('0.5rem');
    expect(val(styles, 'border-top-right-radius')).toBe('0.5rem');
    expect(val(styles, 'border-bottom-right-radius')).toBe('0.5rem');
    expect(val(styles, 'border-bottom-left-radius')).toBe('0.5rem');
  });

  it('expands box shorthands to longhands via the shared normalizer', () => {
    const resolver = createTailwindResolver();
    const { styles } = resolver.resolve({ classes: ['p-4', 'gap-4', 'inset-0'] });

    // gap-4 → row-gap + column-gap.
    expect(val(styles, 'row-gap')).toBe('1rem');
    expect(val(styles, 'column-gap')).toBe('1rem');

    // inset-0 → top/right/bottom/left, with `0px` collapsed to a bare `0`.
    expect(val(styles, 'top')).toBe('0');
    expect(val(styles, 'right')).toBe('0');
    expect(val(styles, 'bottom')).toBe('0');
    expect(val(styles, 'left')).toBe('0');
  });

  it('reports unknown tokens and still resolves the known ones', () => {
    const resolver = createTailwindResolver();
    const { resolved, unknown } = resolver.resolve({
      classes: ['flex', 'totally-made-up-token', 'hidden'],
    });
    expect(resolved).toEqual(['flex', 'hidden']);
    expect(unknown).toEqual(['totally-made-up-token']);
  });

  it('owns real utilities (including arbitrary ones) and rejects junk', () => {
    const resolver = createTailwindResolver();
    expect(resolver.owns('flex')).toBe(true);
    expect(resolver.owns('bg-red-200')).toBe(true);
    expect(resolver.owns('mt-[13px]')).toBe(true); // arbitrary value
    expect(resolver.owns('hover:bg-red-200')).toBe(true); // variant
    expect(resolver.owns('totally-made-up-token')).toBe(false);
    expect(resolver.owns('')).toBe(false);
  });

  it('captures responsive + state variants as distinct conditions (best-effort)', () => {
    const resolver = createTailwindResolver();
    const { styles } = resolver.resolve({ classes: ['hover:bg-red-200', 'md:flex'] });

    // hover state condition.
    const hover = styles.blocks.get(conditionKey({ media: '', states: [':hover'], pseudoElement: '' }));
    expect(hover).toBeDefined();
    expect(hover!.decls.get('background-color' as CssProperty)?.value).toBe(
      'rgb(254 202 202 / var(--tw-bg-opacity, 1))',
    );

    // md: responsive (media) condition.
    const md = styles.blocks.get(
      conditionKey({ media: '(min-width: 768px)', states: [], pseudoElement: '' }),
    );
    expect(md).toBeDefined();
    expect(md!.decls.get('display' as CssProperty)?.value).toBe('flex');
  });

  it('surfaces combinator utilities as opaque rather than polluting BASE', () => {
    const resolver = createTailwindResolver();
    const { styles, opaque, unknown } = resolver.resolve({ classes: ['space-x-4'] });

    expect(unknown).toEqual([]); // the engine knows it
    expect(opaque.some((o) => o.token === 'space-x-4')).toBe(true);
    // No BASE declarations leaked onto the element's own box.
    expect(base(styles)).toBeUndefined();
  });

  it('caches resolution by class-set (returns a stable result)', () => {
    const resolver = createTailwindResolver();
    const a = resolver.resolve({ classes: ['flex', 'p-4'] });
    const b = resolver.resolve({ classes: ['flex', 'p-4'] });
    expect(b).toBe(a);
  });

  it('exposes a tailwindcss provider tag and a fingerprint', () => {
    const resolver = createTailwindResolver();
    expect(resolver.provider).toMatch(/^tailwindcss@3\./);
    expect(resolver.fingerprint.length).toBeGreaterThan(0);
  });
});

describe('createTailwindResolver — reverse emit (best-effort)', () => {
  it('round-trips BASE utilities through resolve → emit (style-level invariant)', () => {
    const resolver = createTailwindResolver();
    const { styles } = resolver.resolve({ classes: ['flex', 'w-full'] });
    const sink = { register: () => '', drain: () => [] };
    const { classes } = resolver.emit(styles, { normalizer, sink });

    // Emit is best-effort: a property may map to any equivalent utility (e.g. width:100% could be
    // `w-full` or `container`). The meaningful invariant is that re-resolving the emitted classes
    // reproduces the original BASE declarations.
    expect(classes.length).toBeGreaterThan(0);
    const round = resolver.resolve({ classes });
    expect(val(round.styles, 'display')).toBe('flex');
    expect(val(round.styles, 'width')).toBe('100%');
  });

  it('never throws and emits nothing for an empty StyleMap', () => {
    const resolver = createTailwindResolver();
    const sink = { register: () => '', drain: () => [] };
    const { styles } = resolver.resolve({ classes: [] });
    const result = resolver.emit(styles, { normalizer, sink });
    expect(result.classes).toEqual([]);
    expect(result.exact).toBe(true);
  });
});
