import { describe, expect, it } from 'vitest';

import type {
  ApplyContext,
  IRDocument,
  Pass,
  PassCategory,
  PassPhase,
  Pattern,
  ResolveInput,
  ResolveResult,
  SafetyLevel,
  SelectorUsage,
  StyleResolver,
} from '@domflax/core';
import {
  buildSelectorIndex,
  createNullResolver,
  createSyntheticSink,
  emptyStyleMap,
  runPasses,
  syncClassesFromComputed,
} from '@domflax/core';
import { normalizer } from '@domflax/pattern-kit';
import { builtinPatterns } from '@domflax/patterns';
import { createTailwindResolver } from '@domflax/resolver-tailwind';

import { createAstroBackend, createAstroFrontend } from '../src/index';

/* ───────────────────────── stub resolvers (mirrors the domflax safety suite) ───────────────────────── */

const NOT_DROPPABLE: SelectorUsage = {
  asSubject: false,
  asAncestor: false,
  asCompound: false,
  asSibling: false,
  asHasArgument: false,
  asStructural: false,
  droppable: false,
};

function baseResolver(over: Partial<StyleResolver>): StyleResolver {
  return {
    id: 'stub',
    provider: 'stub@0.0.0',
    fingerprint: 'stub',
    owns: () => false,
    resolve: () => ({ styles: emptyStyleMap(), resolved: [], unknown: [], opaque: [], warnings: [] }),
    emit: () => ({ classes: [], exact: true, warnings: [] }),
    selectorUsage: () => NOT_DROPPABLE,
    ...over,
  };
}

/** Tokens are KNOWN (resolved) but paint nothing — a genuinely inert, flatten-eligible wrapper. */
function resolvedEmptyResolver(): StyleResolver {
  return baseResolver({
    resolve: (input: ResolveInput): ResolveResult => ({
      styles: emptyStyleMap(),
      resolved: [...input.classes],
      unknown: [],
      opaque: [],
      warnings: [],
    }),
    selectorUsage: () => ({ ...NOT_DROPPABLE, droppable: true }),
  });
}

/* ───────────────────────── pipeline harness (mirrors the frontend-html suite) ───────────────────────── */

/** Group the flat pattern list into one {@link Pass} per {@link PassPhase} (derived from category). */
function buildPasses(patterns: readonly Pattern[]): Pass[] {
  const byPhase = new Map<PassPhase, Pattern[]>();
  for (const p of patterns) {
    const phase = (p.category.split('/', 1)[0] ?? 'flatten') as PassPhase;
    (byPhase.get(phase) ?? byPhase.set(phase, []).get(phase)!).push(p);
  }
  const passes: Pass[] = [];
  for (const [phase, pats] of byPhase) {
    passes.push({ phase, category: `${phase}/builtin` as PassCategory, patterns: pats });
  }
  return passes;
}

function parse(code: string, resolver: StyleResolver): IRDocument {
  const { doc } = createAstroFrontend().parse(code, {
    id: 'Component.astro',
    kind: 'unknown',
    resolver,
    normalizer,
    config: {},
    onDiagnostic: () => {},
  });
  return doc;
}

/** Run the full pipeline: parse → runPasses(provably-safe) → reverse-emit → surgical print. */
function optimize(code: string, resolver: StyleResolver, safety: SafetyLevel = 2): string {
  const doc = parse(code, resolver);
  const ctx: ApplyContext = {
    doc,
    safetyCeiling: safety,
    normalizer,
    selectors: buildSelectorIndex(doc, resolver),
    resolver,
    gate: 'provably-safe',
  };
  const { doc: optimized } = runPasses(doc, buildPasses(builtinPatterns), ctx);
  syncClassesFromComputed(optimized, resolver, normalizer);
  return createAstroBackend().print(
    optimized,
    { moduleId: 'Component.astro', ops: [], provenance: new Map() },
    { normalizer, resolver, sink: createSyntheticSink(), eol: '\n', onDiagnostic: () => {} },
  ).code;
}

/* ───────────────────────── round-trip (byte-for-byte) ───────────────────────── */

const NON_OPT = `---
import Card from './Card.astro';
const title = 'Hello';
---
<Card client:load />
<h1>{title}</h1>
<p class="pad">static {title} text</p>
`;

describe('astro frontend/backend — round-trip', () => {
  it('returns a non-optimizable component (frontmatter + component + {expr}) BYTE-FOR-BYTE', () => {
    expect(optimize(NON_OPT, createNullResolver())).toBe(NON_OPT);
  });

  it('stays byte-identical under the real Tailwind resolver too', () => {
    expect(optimize(NON_OPT, createTailwindResolver())).toBe(NON_OPT);
  });
});

/* ───────────────────────── inert flatten (template offset after frontmatter) ───────────────────────── */

describe('astro frontend/backend — inert flatten', () => {
  it('unwraps a provably-inert wrapper, keeping the child + frontmatter verbatim (stub resolver)', () => {
    const src = `---
const x = 1;
---
<div class="pad"><a class="link">L</a></div>
`;
    const out = optimize(src, resolvedEmptyResolver());
    expect(out).toBe(`---
const x = 1;
---
<a class="link">L</a>
`);
  });

  it('removes a display:contents wrapper under the real Tailwind resolver', () => {
    const src = `---
---
<div class="contents"><a class="text-blue-500">L</a></div>
`;
    const out = optimize(src, createTailwindResolver());
    expect(out).toBe(`---
---
<a class="text-blue-500">L</a>
`);
  });
});

/* ───────────────────────── compress (class VALUE span rewrite, offset-shifted) ───────────────────────── */

describe('astro frontend/backend — compress', () => {
  it('collapses px-4 py-4 → p-4 in the class VALUE span, leaving frontmatter and siblings verbatim', () => {
    const src = `---
const t = 'x';
---
<div class="px-4 py-4">{t}</div>
`;
    const out = optimize(src, createTailwindResolver());
    expect(out).toBe(`---
const t = 'x';
---
<div class="p-4">{t}</div>
`);
  });

  it('never rewrites markup-looking strings INSIDE the frontmatter', () => {
    const src = `---
const s = '<div class="px-4 py-4">x</div>';
---
<span class="px-4 py-4">y</span>
`;
    const out = optimize(src, createTailwindResolver());
    expect(out).toBe(`---
const s = '<div class="px-4 py-4">x</div>';
---
<span class="p-4">y</span>
`);
  });
});

/* ───────────────────────── opaque preservation ───────────────────────── */

describe('astro frontend/backend — opaque preservation', () => {
  const tw = () => createTailwindResolver();

  it('leaves a capitalized component untouched (even with compressible classes)', () => {
    const src = `<Card class="px-4 py-4">x</Card>\n`;
    expect(optimize(src, tw())).toBe(src);
  });

  it('leaves an element with a client: directive untouched', () => {
    const src = `<my-counter client:load class="px-4 py-4">0</my-counter>\n`;
    expect(optimize(src, tw())).toBe(src);
  });

  it('leaves a class:list element untouched', () => {
    const src = `<div class:list={['px-4', 'py-4']}>x</div>\n`;
    expect(optimize(src, tw())).toBe(src);
  });

  it('leaves a spread element untouched', () => {
    const src = `<div {...rest} class="px-4 py-4">x</div>\n`;
    expect(optimize(src, tw())).toBe(src);
  });

  it('leaves a dynamic class={expr} element untouched', () => {
    const src = `<div class={cls}>x</div>\n`;
    expect(optimize(src, tw())).toBe(src);
  });

  it('leaves <slot /> untouched and never flattens a wrapper around it', () => {
    const src = `<div class="pad"><slot /></div>\n`;
    expect(optimize(src, resolvedEmptyResolver())).toBe(src);
  });

  it('leaves an element with an id untouched', () => {
    const src = `<div id="k" class="px-4 py-4">x</div>\n`;
    expect(optimize(src, tw())).toBe(src);
  });

  it('still compresses a NON-opaque sibling of opaque elements', () => {
    const src = `<Card client:load />\n<span class="px-4 py-4">b</span>\n`;
    expect(optimize(src, tw())).toBe(`<Card client:load />\n<span class="p-4">b</span>\n`);
  });
});

/* ───────────────────────── scoped styles → whole-file passthrough ───────────────────────── */

describe('astro frontend/backend — scoped <style> passthrough', () => {
  it('passes a file WITH a <style> block through ENTIRELY unchanged (scoped selectors)', () => {
    const src = `---
---
<div class="contents"><a class="px-4 py-4">L</a></div>
<style>
  a { color: red; }
</style>
`;
    expect(optimize(src, createTailwindResolver())).toBe(src);
  });

  it('registers zero template elements for a styled component (nothing to ever edit)', () => {
    const doc = parse(`<div class="px-4 py-4">x</div>\n<style>div{color:red}</style>\n`, createNullResolver());
    const kinds = [...doc.nodes.values()].map((n) => n.kind);
    expect(kinds).toEqual(['fragment']); // root only — template never lowered
  });
});

/* ───────────────────────── {expr} dynamics ───────────────────────── */

describe('astro frontend/backend — expression opacity', () => {
  it('an {expr} child BLOCKS flattening its parent wrapper', () => {
    const src = `<div class="pad">{x}<a class="link">L</a></div>\n`;
    expect(optimize(src, resolvedEmptyResolver())).toBe(src);
  });

  it('an UNBALANCED expression spanning siblings forces the mis-parsed elements opaque', () => {
    // parse5 lifts the <div> out of the expression as a real sibling element; the unbalanced brace
    // text before it must force it (and its subtree) opaque so nothing inside is rewritten.
    const src = `{cond && <div class="pad"><a class="link">L</a></div>}\n`;
    expect(optimize(src, resolvedEmptyResolver())).toBe(src);
  });

  it('a balanced self-contained {expr} does NOT block optimizing true element siblings', () => {
    const src = `{title}<div class="pad"><a class="link">L</a></div>\n`;
    expect(optimize(src, resolvedEmptyResolver())).toBe(`{title}<a class="link">L</a>\n`);
  });
});

/* ───────────────────────── frontmatter integrity ───────────────────────── */

describe('astro frontend/backend — frontmatter integrity', () => {
  it('never modifies frontmatter even when the template is heavily edited', () => {
    const fm = `---
import x from 'y';
// px-4 py-4 <div class="contents"> --- {expr}
const a = { b: 1 };
---
`;
    const out = optimize(`${fm}<div class="contents"><a class="text-blue-500">L</a></div>\n`, createTailwindResolver());
    expect(out.startsWith(fm)).toBe(true);
    expect(out).toBe(`${fm}<a class="text-blue-500">L</a>\n`);
  });

  it('passes a file with an UNTERMINATED frontmatter fence through unchanged', () => {
    const src = `---
const broken = true;
<div class="px-4 py-4">x</div>
`;
    expect(optimize(src, createTailwindResolver())).toBe(src);
  });
});
