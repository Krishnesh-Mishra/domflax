/**
 * @domflax/patterns — the COMPRESS ENGINE coverage suite.
 *
 * The ~13 hand-written compress patterns (padding/margin/inset/size/gap/place/border/border-radius/
 * overflow/overscroll/scroll-margin/scroll-padding-shorthand + dedupe-classes) were DELETED and
 * replaced by ONE provider-uniform minimal-string exact-cover engine in `@domflax/core`
 * (`compress-engine.ts`), driven by the reverse-emit wrapper. This file preserves every before→after
 * case those patterns asserted — now proven to still hold VIA THE ALGORITHM — and adds the new wins
 * the single engine unlocks that the hand patterns could not express: cross-utility substitution and
 * custom-CSS compression.
 *
 * Each case runs through a REAL end-to-end transform (parse → resolve → reverse-emit → print), exactly
 * as production does — so `px-4 py-4 → p-4` is asserted on printed output, not at the IR level.
 */

import type { FileKind, IRDocument, StyleResolver } from '@domflax/core';
import { createSyntheticSink, syncClassesFromComputed } from '@domflax/core';
import { createJsxBackend, createJsxFrontend } from '@domflax/frontend-jsx';
import { normalizer } from '@domflax/pattern-kit';
import { createCssResolver } from '@domflax/resolver-css';
import { createTailwindResolver } from '@domflax/resolver-tailwind';
import { describe, expect, it } from 'vitest';

/* ───────────────────────── minimal end-to-end transform (compress path only) ───────────────────────── */

function kindOf(id: string): FileKind {
  return id.endsWith('.jsx') ? 'jsx' : 'tsx';
}

function eolOf(doc: IRDocument): '\n' | '\r\n' {
  for (const src of doc.sources.values()) return src.eol;
  return '\n';
}

/**
 * A full single-file transform bound to one resolver. It runs NO flatten passes — only the compress
 * engine via `syncClassesFromComputed` — so each assertion isolates the exact-cover algorithm.
 */
function makeTransform(resolver: StyleResolver): (code: string, filename?: string) => string {
  return (code: string, filename = 'App.tsx'): string => {
    const parsed = createJsxFrontend().parse(code, {
      id: filename,
      kind: kindOf(filename),
      resolver,
      normalizer,
      config: {},
      onDiagnostic: () => {},
    });
    const doc = parsed.doc;
    for (const node of doc.nodes.values()) node.meta.safetyFloor = 3;
    syncClassesFromComputed(doc, resolver, normalizer);
    return createJsxBackend().print(
      doc,
      { moduleId: filename, ops: [], provenance: new Map() },
      { normalizer, resolver, sink: createSyntheticSink(), eol: eolOf(doc), onDiagnostic: () => {} },
    ).code;
  };
}

const tw = makeTransform(createTailwindResolver());

/* ───────────────────────── Tailwind: every deleted shorthand pattern, now via the engine ───────────────────────── */

describe('compress engine — Tailwind shorthand folds (subsumes the deleted patterns)', () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    // [label, before, after]
    ['padding p-4', '<div className="pt-4 pr-4 pb-4 pl-4 bg-red-200">box</div>', '<div className="bg-red-200 p-4">box</div>'],
    ['padding px/py', '<div className="px-4 py-4">{x}</div>', '<div className="p-4">{x}</div>'],
    ['margin m-2', '<div className="mt-2 mr-2 mb-2 ml-2 bg-red-200">box</div>', '<div className="bg-red-200 m-2">box</div>'],
    ['margin mx/my', '<div className="mx-3 my-3">box</div>', '<div className="m-3">box</div>'],
    ['size', '<div className="h-10 w-10 bg-red-200">box</div>', '<div className="bg-red-200 size-10">box</div>'],
    ['inset-0', '<div className="top-0 right-0 bottom-0 left-0 bg-red-200">box</div>', '<div className="bg-red-200 inset-0">box</div>'],
    ['border-2', '<div className="border-t-2 border-r-2 border-b-2 border-l-2 bg-red-200">box</div>', '<div className="bg-red-200 border-2">box</div>'],
    ['border-radius', '<div className="rounded-tl-lg rounded-tr-lg rounded-br-lg rounded-bl-lg bg-red-200">box</div>', '<div className="bg-red-200 rounded-lg">box</div>'],
    ['gap-4', '<div className="gap-x-4 gap-y-4 bg-red-200">box</div>', '<div className="bg-red-200 gap-4">box</div>'],
    ['overflow-auto', '<div className="overflow-x-auto overflow-y-auto bg-red-200">box</div>', '<div className="bg-red-200 overflow-auto">box</div>'],
    ['overscroll-contain', '<div className="overscroll-x-contain overscroll-y-contain bg-red-200">box</div>', '<div className="bg-red-200 overscroll-contain">box</div>'],
    ['place-items-center', '<div className="items-center justify-items-center bg-red-200">box</div>', '<div className="bg-red-200 place-items-center">box</div>'],
    ['scroll-m-4', '<div className="scroll-mt-4 scroll-mr-4 scroll-mb-4 scroll-ml-4 bg-red-200">box</div>', '<div className="bg-red-200 scroll-m-4">box</div>'],
    ['scroll-p-4', '<div className="scroll-pt-4 scroll-pr-4 scroll-pb-4 scroll-pl-4 bg-red-200">box</div>', '<div className="bg-red-200 scroll-p-4">box</div>'],
    // dedupe: text-sm is fully overridden by text-lg (both set font-size + line-height).
    ['dedupe text-lg', '<p className="text-sm text-lg">Hi</p>', '<p className="text-lg">Hi</p>'],
  ];
  for (const [label, before, after] of cases) {
    it(label, () => expect(tw(before)).toBe(after));
  }
});

describe('compress engine — Tailwind noMatch (asymmetric/ambiguous shapes left unchanged)', () => {
  const unchanged: readonly string[] = [
    '<div className="h-10 w-20 bg-red-200">box</div>', // width != height (no size-* equivalent)
    '<div className="top-0 right-1 bottom-2 left-3 bg-red-200">box</div>', // all insets distinct
    '<div className="gap-x-2 gap-y-4 bg-red-200">box</div>', // unequal gap axes (no single gap-*)
    '<div className="overflow-x-auto overflow-y-hidden bg-red-200">box</div>', // mismatched overflow
    '<p className="text-lg font-bold">Hi</p>', // no full override
  ];
  for (const code of unchanged) {
    it(`unchanged: ${code}`, () => expect(tw(code)).toBe(code));
  }
});

describe('compress engine — cross-utility wins the hand patterns MISSED', () => {
  it('folds padding AND size together in ONE solve (kept bg-white)', () => {
    // A single exact-cover pass folds px-4 py-4 → p-4 and h-10 w-10 → size-10 together, keeping bg-white.
    expect(tw('<div className="px-4 py-4 h-10 w-10 bg-white">x</div>')).toBe(
      '<div className="bg-white p-4 size-10">x</div>',
    );
  });

  it('collapses the equal x-pair of an asymmetric box (pr-4 pl-4 → px-4)', () => {
    // The old all-four-equal padding pattern left this UNTOUCHED; the engine finds pr-4+pl-4 → px-4.
    expect(tw('<div className="pt-2 pr-4 pb-8 pl-4 bg-red-200">box</div>')).toBe(
      '<div className="pt-2 pb-8 bg-red-200 px-4">box</div>',
    );
  });

  it('collapses an equal two-side margin pair (mt-2 mb-2 → my-2)', () => {
    // The old margin pattern required all FOUR sides; the engine folds the equal top/bottom pair.
    expect(tw('<div className="mt-2 mb-2 bg-red-200">box</div>')).toBe(
      '<div className="bg-red-200 my-2">box</div>',
    );
  });
});

/* ───────────────────────── Custom CSS: compression that ONLY the engine can do ───────────────────────── */

describe('compress engine — custom CSS (shortest exact cover + redundant-class drop, never inflate)', () => {
  // A synthetic stylesheet: `.a` sets {color,padding}; `.short` sets the SAME padding; `.c` sets the
  // same color. So `.a` == `.c` + `.short` in effect. The reverse-emit picks the SHORTEST exact cover.
  const css = [
    '.a { color: #ff0000; padding: 8px }',
    '.short { padding: 8px }',
    '.c { color: #ff0000 }',
  ].join('\n');
  const custom = makeTransform(createCssResolver([{ id: 'syn.css', css }]));

  it('drops a class whose declarations another class already fully provides', () => {
    // `.short`'s padding is already provided by `.a` → the redundant `.short` is dropped (`.a` alone
    // reproduces the exact computed style and is the shortest cover).
    expect(custom('<div className="a short">x</div>')).toBe('<div className="a">x</div>');
  });

  it('never inflates: a lone class that is already the shortest cover is left byte-for-byte', () => {
    expect(custom('<div className="a">x</div>')).toBe('<div className="a">x</div>');
  });

  it('picks the single class over a longer equivalent multi-class set', () => {
    // `.c .short` (7 chars incl. space) reproduces the same {color,padding} as `.a` (1 char) → the
    // engine collapses to `.a`, the minimal-string cover.
    expect(custom('<div className="c short">x</div>')).toBe('<div className="a">x</div>');
  });
});
