import { describe, it, expect } from 'vitest';

import type { CssProperty, StyleMap } from '@domflax/core';
import { BASE_CONDITION, conditionKey, emptyStyleMap } from '@domflax/core';
import { normalizer } from '@domflax/pattern-kit';

import { CustomCSSResolver, createCssResolver } from './index';

const SAMPLE = `
  .card { padding: 1rem; display: flex }
  .muted { color: #888 }
  .list > .item h3 { color: red }
`;

const baseBlock = (sm: StyleMap) => sm.blocks.get(conditionKey(BASE_CONDITION));

describe('createCssResolver — forward resolve', () => {
  it('resolves .card into the normalized BASE block (shorthand expanded)', () => {
    const resolver = createCssResolver([{ id: 'in.css', css: SAMPLE }]);
    const { styles, resolved, unknown } = resolver.resolve({ classes: ['card'] });

    expect(resolved).toEqual(['card']);
    expect(unknown).toEqual([]);

    const block = baseBlock(styles)!;
    expect(block).toBeDefined();
    expect(block.decls.get('display' as CssProperty)?.value).toBe('flex');
    // `padding: 1rem` expands to four longhand sides via the shared normalizer.
    expect(block.decls.get('padding-top' as CssProperty)?.value).toBe('1rem');
    expect(block.decls.get('padding-right' as CssProperty)?.value).toBe('1rem');
    expect(block.decls.get('padding-bottom' as CssProperty)?.value).toBe('1rem');
    expect(block.decls.get('padding-left' as CssProperty)?.value).toBe('1rem');
  });

  it('canonicalizes color values', () => {
    const resolver = createCssResolver([{ id: 'in.css', css: SAMPLE }]);
    const block = baseBlock(resolver.resolve({ classes: ['muted'] }).styles)!;
    expect(block.decls.get('color' as CssProperty)?.value).toBe('#888888');
  });

  it('reports unknown tokens and resolves known ones', () => {
    const resolver = createCssResolver([{ id: 'in.css', css: SAMPLE }]);
    const { resolved, unknown } = resolver.resolve({ classes: ['card', 'nope', 'muted'] });
    expect(resolved).toEqual(['card', 'muted']);
    expect(unknown).toEqual(['nope']);
  });

  it('does not fold combinator-rule declarations into a plain class', () => {
    const resolver = createCssResolver([{ id: 'in.css', css: SAMPLE }]);
    // `.list`, `.item`, `h3` appear only in a complex selector — none forward-resolve.
    expect(normalizer.equals(resolver.resolve({ classes: ['item'] }).styles, emptyStyleMap())).toBe(
      true,
    );
    expect(resolver.resolve({ classes: ['item'] }).unknown).toEqual(['item']);
  });

  it('cascades equal-specificity single-class rules by source order (later wins)', () => {
    const css = `.a { color: red } .a { color: blue }`;
    const resolver = createCssResolver([{ id: 'in.css', css }]);
    const block = baseBlock(resolver.resolve({ classes: ['a'] }).styles)!;
    expect(block.decls.get('color' as CssProperty)?.value).toBe('blue');
  });

  it('maps @media wrappers to conditioned blocks; BASE is the unconditional block', () => {
    const css = `.x { color: red } @media (min-width: 640px) { .x { color: blue } }`;
    const resolver = createCssResolver([{ id: 'in.css', css }]);
    const { styles } = resolver.resolve({ classes: ['x'] });
    expect(baseBlock(styles)!.decls.get('color' as CssProperty)?.value).toBe('red');
    const media = styles.blocks.get(
      conditionKey({ media: '(min-width: 640px)', states: [], pseudoElement: '' }),
    );
    expect(media?.decls.get('color' as CssProperty)?.value).toBe('blue');
  });
});

describe('CustomCSSResolver — selectorUsage + complex selectors', () => {
  it('reports the complex combinator selector', () => {
    const resolver = new CustomCSSResolver([{ id: 'in.css', css: SAMPLE }]);
    expect(resolver.complexSelectors()).toContain('.list > .item h3');
  });

  it('flags ancestor / subject roles and droppability accurately', () => {
    const resolver = new CustomCSSResolver([{ id: 'in.css', css: SAMPLE }]);

    // `.list` is an ancestor hook (followed by `>`), never a plain subject → not droppable.
    const list = resolver.selectorUsage('list');
    expect(list.asAncestor).toBe(true);
    expect(list.droppable).toBe(false);

    // `.item` is the (child-combinated) middle compound — ancestor of `h3`, load-bearing.
    const item = resolver.selectorUsage('item');
    expect(item.asAncestor).toBe(true);
    expect(item.droppable).toBe(false);

    // `.card` only ever appears as a bare `.card {}` subject → safely droppable.
    const card = resolver.selectorUsage('card');
    expect(card.asSubject).toBe(true);
    expect(card.droppable).toBe(true);
  });

  it('flags structural pseudos and :has arguments', () => {
    const css = `.row:nth-child(2) { color: red } .panel:has(.flag) { color: blue }`;
    const resolver = new CustomCSSResolver([{ id: 'in.css', css }]);

    expect(resolver.selectorUsage('row').asStructural).toBe(true);
    expect(resolver.selectorUsage('row').droppable).toBe(false);
    expect(resolver.selectorUsage('flag').asHasArgument).toBe(true);

    expect(resolver.complexSelectors()).toContain('.row:nth-child(2)');
  });

  it('returns a safe default for unknown tokens', () => {
    const resolver = new CustomCSSResolver([{ id: 'in.css', css: SAMPLE }]);
    const u = resolver.selectorUsage('never-seen');
    expect(u.asSubject).toBe(false);
    expect(u.droppable).toBe(true);
  });
});

describe('CustomCSSResolver — emit (reverse)', () => {
  it('maps a StyleMap back to the minimal set of existing classes', () => {
    const resolver = createCssResolver([{ id: 'in.css', css: SAMPLE }]) as CustomCSSResolver;
    const target = resolver.resolve({ classes: ['card', 'muted'] }).styles;
    const { classes, exact } = resolver.emit(target, { normalizer, sink: stubSink() });
    expect(exact).toBe(true);
    expect([...classes].sort()).toEqual(['card', 'muted']);
  });

  it('never throws and reports inexact when nothing matches', () => {
    const resolver = createCssResolver([{ id: 'in.css', css: SAMPLE }]);
    const foreign: StyleMap = {
      blocks: new Map([
        [
          conditionKey(BASE_CONDITION),
          {
            condition: BASE_CONDITION,
            decls: new Map([
              [
                'z-index' as CssProperty,
                normalizer.normalizeDeclaration('z-index', '99', false)[0]!,
              ],
            ]),
          },
        ],
      ]),
    };
    const result = resolver.emit(foreign, { normalizer, sink: stubSink() });
    expect(result.classes).toEqual([]);
    expect(result.exact).toBe(false);
  });
});

describe('owns', () => {
  it('owns referenced plain classes only', () => {
    const resolver = createCssResolver([{ id: 'in.css', css: SAMPLE }]);
    expect(resolver.owns('card')).toBe(true);
    expect(resolver.owns('list')).toBe(true); // referenced (in a complex selector)
    expect(resolver.owns('totally-unseen')).toBe(false);
  });
});

function stubSink() {
  return {
    register: (s: { className: string }) => s.className,
    drain: () => [],
  };
}
