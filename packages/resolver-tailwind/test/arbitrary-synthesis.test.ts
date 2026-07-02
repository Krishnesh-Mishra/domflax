/**
 * FEATURE A — arbitrary-value synthesis: the reverse (emit) side proposes `stem-[value]` candidates
 * for one-property families and admits them ONLY after a round-trip through the real engine.
 *
 *   • real v3 engine: `h-[40px] w-[40px]` folds to `size-[40px]`; the four `p*-[7px]` sides fold to
 *     `p-[7px]`; enumerated utilities still beat synthesized ones when the value matches the scale.
 *   • v4 (engine-level, no real v4 project needed): the snapshot engine's `prime` batches candidate
 *     fetches, and a BOGUS synthesized candidate (whose fetched CSS does not match the intended
 *     declarations) is REJECTED by the round-trip validation.
 */

import { describe, it, expect } from 'vitest';

import type { CssProperty, StyleDecl, StyleMap, SyntheticSink } from '@domflax/core';
import { BASE_CONDITION, conditionKey } from '@domflax/core';
import { normalizer } from '@domflax/pattern-kit';

import { createTailwindResolver } from '../src/index';
import { extractionTuples, tryExactCover } from '../src/tailwind/cover';
import type { CoverHost } from '../src/tailwind/cover';
import { makeV4Engine } from '../src/tailwind/engine-v4';
import { extractToken } from '../src/tailwind/extract';
import { arbitraryValue, synthesizeProposals } from '../src/tailwind/synthesize';

const sink: SyntheticSink = { register: (s) => s.className, drain: () => [] };

function baseDecls(sm: StyleMap): ReadonlyMap<CssProperty, StyleDecl> {
  return sm.blocks.get(conditionKey(BASE_CONDITION))?.decls ?? new Map();
}

describe('feature A — arbitrary-value synthesis (real v3 engine)', () => {
  const resolver = createTailwindResolver();

  it('folds h-[40px] w-[40px] into size-[40px]', () => {
    const { styles, unknown } = resolver.resolve({ classes: ['h-[40px]', 'w-[40px]'] });
    expect(unknown).toEqual([]);
    const { classes, exact } = resolver.emit(styles, { normalizer, sink });
    expect(classes).toEqual(['size-[40px]']);
    expect(exact).toBe(true);
    // Round-trip invariant: the emitted set re-resolves to the exact same style.
    expect(normalizer.equals(resolver.resolve({ classes: [...classes] }).styles, styles)).toBe(true);
  });

  it('folds the four pt/pr/pb/pl-[7px] sides into p-[7px]', () => {
    const { styles } = resolver.resolve({
      classes: ['pt-[7px]', 'pb-[7px]', 'pl-[7px]', 'pr-[7px]'],
    });
    const { classes } = resolver.emit(styles, { normalizer, sink });
    expect(classes).toEqual(['p-[7px]']);
    expect(normalizer.equals(resolver.resolve({ classes: [...classes] }).styles, styles)).toBe(true);
  });

  it('folds equal top/bottom margins into my-[..]', () => {
    const { styles } = resolver.resolve({ classes: ['mt-[3px]', 'mb-[3px]'] });
    const { classes } = resolver.emit(styles, { normalizer, sink });
    expect(classes).toEqual(['my-[3px]']);
  });

  it('prefers the SHORTER enumerated utility over a synthesized arbitrary one (p-4 vs p-[1rem])', () => {
    const { styles } = resolver.resolve({ classes: ['pt-[1rem]', 'pb-[1rem]', 'pl-[1rem]', 'pr-[1rem]'] });
    const { classes } = resolver.emit(styles, { normalizer, sink });
    expect(classes).toEqual(['p-4']); // 1rem IS on the scale — cost picks the enumerated token
  });
});

describe('feature A — proposal generation + validation guards', () => {
  it('proposes size/p/w/h candidates for matching declaration groups', () => {
    const decls = new Map<CssProperty, StyleDecl>();
    for (const [p, v] of [
      ['width', '40px'],
      ['height', '40px'],
    ] as const) {
      for (const d of normalizer.normalizeDeclaration(p, v, false)) decls.set(d.property, d);
    }
    const tokens = synthesizeProposals(decls).map((p) => p.token);
    expect(tokens).toContain('size-[40px]');
    expect(tokens).toContain('w-[40px]');
    expect(tokens).toContain('h-[40px]');
  });

  it('never proposes for !important or mismatched values, and escapes/refuses unsafe values', () => {
    const decls = new Map<CssProperty, StyleDecl>();
    for (const d of normalizer.normalizeDeclaration('width', '40px', true)) decls.set(d.property, d);
    expect(synthesizeProposals(decls)).toEqual([]); // !important → no proposal

    expect(arbitraryValue('1px solid red')).toBe('1px_solid_red'); // spaces → underscores
    expect(arbitraryValue('a_b')).toBeNull(); // literal underscore is ambiguous → refuse
    expect(arbitraryValue('x[y]')).toBeNull(); // brackets can't nest → refuse
  });
});

/* ───────────────────────── v4 engine-level (snapshot + prime) ───────────────────────── */

/** Build a CoverHost over a v4 snapshot engine (mirrors the resolver's host, minus variants). */
function v4Host(engine: ReturnType<typeof makeV4Engine>): CoverHost {
  const extract = (t: string) => extractToken(t, engine.generate([t]));
  return {
    vocab: () => [],
    extract,
    prime: (tokens) => engine.prime?.(tokens),
    prefixFor: () => undefined,
    learn: () => {},
    resolveStyles: (classes) => {
      // Minimal forward resolution for the backstop: union all classes' base decls.
      const decls = new Map<CssProperty, StyleDecl>();
      for (const c of classes) {
        const ex = extract(c);
        for (const b of ex.blocks) {
          for (const [prop, value, important] of b.decls) {
            for (const d of normalizer.normalizeDeclaration(prop, value, important)) {
              decls.set(d.property, d);
            }
          }
        }
      }
      const block = { condition: BASE_CONDITION, decls };
      return normalizer.normalizeStyleMap({
        blocks: new Map([[conditionKey(BASE_CONDITION), block]]),
      });
    },
  };
}

function targetOf(pairs: ReadonlyArray<readonly [string, string]>): StyleMap {
  const decls = new Map<CssProperty, StyleDecl>();
  for (const [p, v] of pairs) {
    for (const d of normalizer.normalizeDeclaration(p, v, false)) decls.set(d.property, d);
  }
  return normalizer.normalizeStyleMap({
    blocks: new Map([[conditionKey(BASE_CONDITION), { condition: BASE_CONDITION, decls }]]),
  });
}

describe('feature A — v4 snapshot engine (candidatesToCss accepts arbitrary values via prime)', () => {
  const GOOD: Record<string, string> = {
    'size-[40px]': '.size-\\[40px\\]{width:40px;height:40px}',
    'w-[40px]': '.w-\\[40px\\]{width:40px}',
    'h-[40px]': '.h-\\[40px\\]{height:40px}',
  };

  it('prime batches misses through the candidate fetch and the cover folds to size-[40px]', () => {
    const fetches: string[][] = [];
    const engine = makeV4Engine([], '4.1.0', (tokens) => {
      fetches.push([...tokens]);
      return tokens.map((t) => [t, GOOD[t] ?? ''] as const);
    });
    const target = targetOf([
      ['width', '40px'],
      ['height', '40px'],
    ]);
    const result = tryExactCover(v4Host(engine), target, normalizer, ['h-[40px]', 'w-[40px]']);
    expect(result?.classes).toEqual(['size-[40px]']);
    // All pending candidates were primed in ONE batch (per emit), not one child call per token.
    expect(fetches.length).toBe(1);
  });

  it('REJECTS a bogus synthesized candidate whose round-trip does not match the intended decls', () => {
    const engine = makeV4Engine([], '4.1.0', (tokens) =>
      tokens.map((t) => {
        if (t === 'size-[40px]') return [t, '.size-\\[40px\\]{width:41px;height:41px}'] as const; // LIES
        return [t, GOOD[t] ?? ''] as const;
      }),
    );
    const target = targetOf([
      ['width', '40px'],
      ['height', '40px'],
    ]);
    const result = tryExactCover(v4Host(engine), target, normalizer, ['h-[40px]', 'w-[40px]']);
    // size-[40px] resolves to 41px → validation rejects it; the honest per-side tokens win.
    expect(result?.classes).toEqual(['h-[40px]', 'w-[40px]']);
  });

  it('extractionTuples refuses unresolvable tokens (round-trip cannot be skipped)', () => {
    const engine = makeV4Engine([], '4.1.0', () => null);
    const ex = extractToken('size-[40px]', engine.generate(['size-[40px]']));
    expect(extractionTuples(ex, normalizer)).toBeNull();
  });
});
