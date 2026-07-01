/**
 * domflax — SAFETY regression: an element whose classes could NOT be resolved must never be flattened.
 *
 * The style resolver is built for Tailwind v3. When it cannot resolve an element's classes — the
 * canonical case being a Tailwind-v4 project (a different engine the v3 resolver cannot drive) — it
 * yields an EMPTY computed StyleMap AND reports those tokens as `unknown`. Pre-fix, domflax read only
 * the empty computed and treated the element as style-less/inert, UNSAFELY FLATTENING it (dropping its
 * real background/size/padding). This suite pins the fix (Layer 2): an unresolved class ⇒ UNKNOWN
 * style ⇒ the element is PRESERVED, in BOTH the JSX and HTML pipelines. A class that RESOLVED to no
 * paint (known, non-painting) still flattens — proving "could-not-resolve" is distinguished from
 * "resolved-empty".
 */

import { describe, expect, it } from 'vitest';

import type {
  ApplyContext,
  FileKind,
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
  createSyntheticSink,
  emptyStyleMap,
  runPasses,
  syncClassesFromComputed,
} from '@domflax/core';
import { normalizer } from '@domflax/pattern-kit';
import { builtinPatterns } from '@domflax/patterns';
import { createHtmlBackend, createHtmlFrontend } from '@domflax/frontend-html';
import { createJsxBackend, createJsxFrontend } from '@domflax/frontend-jsx';

import { createDomflax } from '../src/index';

/* ───────────────────────── stub resolvers ───────────────────────── */

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

/** Mirrors Tailwind v4 through the v3 resolver: every PRESENT token is reported UNKNOWN, no styles. */
function allUnknownResolver(): StyleResolver {
  return baseResolver({
    resolve: (input: ResolveInput): ResolveResult => ({
      styles: emptyStyleMap(),
      resolved: [],
      unknown: [...input.classes],
      opaque: [],
      warnings: [],
    }),
  });
}

/** Contrast: tokens are KNOWN (resolved) but paint nothing — a genuinely inert, flatten-eligible wrapper. */
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

/* ───────────────────────── full-pipeline harnesses (parse → passes → emit → print) ───────────────────────── */

function buildPasses(patterns: readonly Pattern[]): Pass[] {
  const byPhase = new Map<PassPhase, Pattern[]>();
  for (const p of patterns) {
    const phase = (p.category.split('/', 1)[0] ?? 'flatten') as PassPhase;
    (byPhase.get(phase) ?? byPhase.set(phase, []).get(phase)!).push(p);
  }
  return [...byPhase].map(([phase, pats]) => ({
    phase,
    category: `${phase}/builtin` as PassCategory,
    patterns: pats,
  }));
}

function ctxFor(doc: IRDocument, resolver: StyleResolver): ApplyContext {
  return {
    doc,
    safetyCeiling: 2 as SafetyLevel,
    normalizer,
    selectors: buildSelectorIndex(doc, resolver),
    resolver,
    gate: 'provably-safe',
  };
}

function optimizeJsx(code: string, resolver: StyleResolver): string {
  const { doc } = createJsxFrontend().parse(code, {
    id: 'A.tsx',
    kind: 'tsx' as FileKind,
    resolver,
    normalizer,
    config: {},
    onDiagnostic: () => {},
  });
  for (const node of doc.nodes.values()) node.meta.safetyFloor = 3;
  const { doc: optimized } = runPasses(doc, buildPasses(builtinPatterns), ctxFor(doc, resolver));
  syncClassesFromComputed(optimized, resolver, normalizer);
  return createJsxBackend().print(
    optimized,
    { moduleId: 'A.tsx', ops: [], provenance: new Map() },
    { normalizer, resolver, sink: createSyntheticSink(), eol: '\n', onDiagnostic: () => {} },
  ).code;
}

function optimizeHtml(code: string, resolver: StyleResolver): string {
  const { doc } = createHtmlFrontend().parse(code, {
    id: 'index.html',
    kind: 'html' as FileKind,
    resolver,
    normalizer,
    config: {},
    onDiagnostic: () => {},
  });
  const { doc: optimized } = runPasses(doc, buildPasses(builtinPatterns), ctxFor(doc, resolver));
  syncClassesFromComputed(optimized, resolver, normalizer);
  return createHtmlBackend().print(
    optimized,
    { moduleId: 'index.html', ops: [], provenance: new Map() },
    { normalizer, resolver, sink: createSyntheticSink(), eol: '\n', onDiagnostic: () => {} },
  ).code;
}

/* ───────────────────────── Layer 2 — unresolved ⇒ preserved (the v4 scenario) ───────────────────────── */

describe('Layer 2 — an element with UNRESOLVED classes is never flattened (v4 scenario)', () => {
  it('JSX: the exact repro — an unresolvable bg-white div is PRESERVED, not deleted', () => {
    const code =
      'export default function A(){return (' +
      '<div className="px-4 py-4 h-10 w-10 bg-white"><span className="pt-2 pb-2">{x}</span></div>' +
      ');}';
    const out = optimizeJsx(code, allUnknownResolver());

    // The whole wrapper survives verbatim — nothing was flattened or compressed away.
    expect(out).toContain('className="px-4 py-4 h-10 w-10 bg-white"');
    expect(out).toContain('className="pt-2 pb-2"');
    expect(out).toContain('{x}');
  });

  it('JSX: a purely inert-looking wrapper with an unresolved class is still PRESERVED', () => {
    const out = optimizeJsx(
      'export default function W(){return (<div className="pad"><a className="link">L</a></div>);}',
      allUnknownResolver(),
    );
    expect(out).toContain('className="pad"');
    expect(out).toContain('className="link"');
  });

  it('HTML: an unresolved wrapper is PRESERVED (byte-identical)', () => {
    const src = '<div class="pad"><a class="link">L</a></div>';
    expect(optimizeHtml(src, allUnknownResolver())).toBe(src);
  });

  it('CONTRAST: a wrapper whose class RESOLVED to no paint (known, inert) still FLATTENS', () => {
    // Same shape, but the stub reports the class as RESOLVED (not unknown) with empty styles — so the
    // wrapper is provably inert and the child is hoisted. This proves "could-not-resolve" (preserve) is
    // distinguished from "resolved-empty" (safe to flatten).
    const src = '<div class="pad"><a class="link">L</a></div>';
    const out = optimizeHtml(src, resolvedEmptyResolver());
    expect(out).not.toContain('class="pad"');
    expect(out).toContain('<a class="link">L</a>');
  });
});

/* ───────────────────────── Layer 2 does not regress the real Tailwind v3 engine ───────────────────────── */

describe('Layer 2 — real Tailwind v3 still flattens/compresses exactly as before (no false opacity)', () => {
  it('compresses px-4 py-4 → p-4 and preserves the bg-white div', () => {
    const { code: out } = createDomflax().transform('<div className="px-4 py-4 bg-white">x</div>', 'S.tsx');
    expect(out).toContain('p-4');
    expect(out).not.toContain('px-4');
    expect(out).not.toContain('py-4');
    expect(out).toContain('bg-white');
  });

  it('still flattens an inert display:contents wrapper (resolved, no paint)', () => {
    const { code: out } = createDomflax().transform(
      '<div class="contents"><a class="text-blue-500">L</a></div>',
      'index.html',
    );
    expect(out).toBe('<a class="text-blue-500">L</a>');
  });
});
