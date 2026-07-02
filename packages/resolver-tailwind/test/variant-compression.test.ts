/**
 * FEATURE B — variant-aware compression (real v3 engine): tokens under the SAME normalized variant
 * chain compress together (`hover:px-4 hover:py-4` → `hover:p-4`; `md:h-10 md:w-10` → `md:size-10`),
 * different chains never mix, unknown variants stay verbatim, and every rewrite re-resolves to the
 * exact original style (asserted here and enforced in-engine by the cover backstop + reverse-emit's
 * mandatory equality gate).
 */

import { describe, it, expect } from 'vitest';

import type { SyntheticSink } from '@domflax/core';
import { normalizer } from '@domflax/pattern-kit';

import { createTailwindResolver } from '../src/index';
import { splitVariantChain } from '../src/tailwind/variants';

const sink: SyntheticSink = { register: (s) => s.className, drain: () => [] };

describe('feature B — variant chain splitting', () => {
  it('splits at the last top-level colon, bracket-aware', () => {
    expect(splitVariantChain('hover:px-4')).toEqual({ chain: 'hover:', root: 'px-4' });
    expect(splitVariantChain('md:hover:p-4')).toEqual({ chain: 'md:hover:', root: 'p-4' });
    expect(splitVariantChain('data-[state=open]:p-4')).toEqual({
      chain: 'data-[state=open]:',
      root: 'p-4',
    });
    expect(splitVariantChain('bg-[url(http://x/y.png)]')).toBeNull(); // colon inside brackets
    expect(splitVariantChain('p-4')).toBeNull();
  });
});

describe('feature B — variant-aware emit (real v3 engine)', () => {
  const resolver = createTailwindResolver();

  it('folds hover:px-4 hover:py-4 into hover:p-4 (same chain, re-resolve equal)', () => {
    const source = ['hover:px-4', 'hover:py-4'];
    const { styles, unknown } = resolver.resolve({ classes: source });
    expect(unknown).toEqual([]);
    const { classes, exact } = resolver.emit(styles, { normalizer, sink, sourceTokens: source });
    expect(classes).toEqual(['hover:p-4']);
    expect(exact).toBe(true);
    // RE-RESOLVE EQUALITY: identical condition keys + declarations.
    expect(normalizer.equals(resolver.resolve({ classes: [...classes] }).styles, styles)).toBe(true);
  });

  it('folds md:h-10 md:w-10 into md:size-10', () => {
    const source = ['md:h-10', 'md:w-10'];
    const { styles } = resolver.resolve({ classes: source });
    const { classes } = resolver.emit(styles, { normalizer, sink, sourceTokens: source });
    expect(classes).toEqual(['md:size-10']);
    expect(normalizer.equals(resolver.resolve({ classes: [...classes] }).styles, styles)).toBe(true);
  });

  it('variant + arbitrary value combine: hover:h-[40px] hover:w-[40px] → hover:size-[40px]', () => {
    const source = ['hover:h-[40px]', 'hover:w-[40px]'];
    const { styles } = resolver.resolve({ classes: source });
    const { classes } = resolver.emit(styles, { normalizer, sink, sourceTokens: source });
    expect(classes).toEqual(['hover:size-[40px]']);
    expect(normalizer.equals(resolver.resolve({ classes: [...classes] }).styles, styles)).toBe(true);
  });

  it('NEVER mixes different chains (hover:px-4 + md:py-4 stay separate)', () => {
    const source = ['hover:px-4', 'md:py-4'];
    const { styles } = resolver.resolve({ classes: source });
    const { classes } = resolver.emit(styles, { normalizer, sink, sourceTokens: source });
    expect([...classes].sort()).toEqual(['hover:px-4', 'md:py-4']); // no cross-chain hybrid
    expect(classes).not.toContain('p-4');
    expect(normalizer.equals(resolver.resolve({ classes: [...classes] }).styles, styles)).toBe(true);
  });

  it('base + variant compress independently in one solve', () => {
    const source = ['px-4', 'py-4', 'hover:px-2', 'hover:py-2'];
    const { styles } = resolver.resolve({ classes: source });
    const { classes } = resolver.emit(styles, { normalizer, sink, sourceTokens: source });
    expect([...classes].sort()).toEqual(['hover:p-2', 'p-4']);
  });
});

describe('feature B — droppability tiers (selectorUsage)', () => {
  const resolver = createTailwindResolver();

  it('marks validated variant tokens REBUILDABLE (not droppable) and plain utilities droppable', () => {
    const hover = resolver.selectorUsage('hover:px-4');
    expect(hover.droppable).toBe(false);
    expect(hover.rebuildable).toBe(true);

    const md = resolver.selectorUsage('md:w-10');
    expect(md.droppable).toBe(false);
    expect(md.rebuildable).toBe(true);

    expect(resolver.selectorUsage('px-4').droppable).toBe(true);
  });

  it('keeps NON-round-trippable variants opaque (before: injects content; space-x-4 is combinator)', () => {
    const before = resolver.selectorUsage('before:pt-1');
    expect(before.droppable).toBe(false);
    expect(before.rebuildable).not.toBe(true); // ::before adds `content` the root lacks

    const spaceX = resolver.selectorUsage('space-x-4');
    expect(spaceX.droppable).toBe(false);
    expect(spaceX.rebuildable).not.toBe(true);
  });
});
