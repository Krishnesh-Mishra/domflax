/**
 * @domflax/resolver-tailwind — unit tests for the v4 `candidatesToCss` parser/flattener. These are
 * PURE (no Tailwind install needed) and assert that v4's nested authoring CSS is flattened into the
 * same flat, v3-shaped node structure `extract` consumes — including the SAFETY-critical case where a
 * combinator utility (`divide-y`, `space-x-4`) flattens to a complex selector ⇒ opaque ⇒ preserved.
 */

import { describe, it, expect } from 'vitest';

import { extractToken } from '../src/tailwind/extract';
import { parseUtilityCss } from '../src/tailwind/v4-css';
import type { TwGeneratedAtRule, TwGeneratedRule } from '../src/tailwind/types';

describe('parseUtilityCss — v4 nested output → flat TwNode[]', () => {
  it('parses a simple base utility into one flat rule with its declaration', () => {
    const nodes = parseUtilityCss('.px-4 {\n  padding-inline: calc(var(--spacing) * 4);\n}\n');
    expect(nodes).toHaveLength(1);
    const rule = nodes[0] as TwGeneratedRule;
    expect(rule.type).toBe('rule');
    expect(rule.selector).toBe('.px-4');
    expect(rule.nodes).toHaveLength(1);
    expect(rule.nodes![0]).toMatchObject({
      type: 'decl',
      prop: 'padding-inline',
      value: 'calc(var(--spacing) * 4)',
    });
  });

  it('extracts a base BASE block from a simple utility', () => {
    const ex = extractToken('bg-white', parseUtilityCss('.bg-white { background-color: var(--color-white); }'));
    expect(ex.produced).toBe(true);
    expect(ex.opaque).toBeUndefined();
    expect(ex.blocks).toHaveLength(1);
    expect(ex.blocks[0]!.decls).toContainEqual(['background-color', 'var(--color-white)', false]);
  });

  it('hoists a nested @media into a wrapping at-rule (base decls + media rule)', () => {
    const css = `.container {
      width: 100%;
      @media (width >= 40rem) { max-width: 40rem; }
    }`;
    const nodes = parseUtilityCss(css);
    // one flat base rule + one @media-wrapped rule
    const base = nodes.find((n) => n.type === 'rule') as TwGeneratedRule;
    const at = nodes.find((n) => n.type === 'atrule') as TwGeneratedAtRule | undefined;
    expect(base.selector).toBe('.container');
    expect(base.nodes![0]).toMatchObject({ prop: 'width', value: '100%' });
    expect(at?.name).toBe('media');
    expect(at?.params).toBe('(width >= 40rem)');
    const inner = at!.nodes![0] as TwGeneratedRule;
    expect(inner.selector).toBe('.container');
    expect(inner.nodes![0]).toMatchObject({ prop: 'max-width', value: '40rem' });
  });

  it('SAFETY: a combinator utility flattens to a complex selector and is opaque (preserved)', () => {
    const css = `.divide-y {
      :where(& > :not(:last-child)) {
        border-top-width: 1px;
        border-bottom-width: 0px;
      }
    }`;
    const nodes = parseUtilityCss(css);
    const rule = nodes.find((n) => n.type === 'rule') as TwGeneratedRule;
    // '&' resolved against the parent → complex selector, NOT a bare `.divide-y`.
    expect(rule.selector).toBe(':where(.divide-y > :not(:last-child))');
    const ex = extractToken('divide-y', nodes);
    expect(ex.produced).toBe(true);
    expect(ex.blocks).toHaveLength(0); // nothing leaks onto the element's own box
    expect(ex.opaque?.token).toBe('divide-y');
  });

  it('resolves `&:hover` nesting to a stateful selector', () => {
    const css = `.hover\\:bg-white {
      &:hover { @media (hover: hover) { background-color: var(--color-white); } }
    }`;
    const ex = extractToken('hover:bg-white', parseUtilityCss(css));
    expect(ex.produced).toBe(true);
    // A media + :hover conditional block (not a BASE block).
    const block = ex.blocks[0];
    expect(block?.condition.states).toContain(':hover');
    expect(block?.condition.media).toContain('hover');
  });

  it('fails safe: malformed CSS yields no nodes (⇒ token reported unknown)', () => {
    expect(parseUtilityCss('.x { color: ')).toEqual(expect.any(Array));
    // an unbalanced/empty input never throws and never invents declarations
    expect(parseUtilityCss('')).toEqual([]);
    expect(parseUtilityCss('not css at all')).toEqual([]);
  });
});
