import { describe, expect, it } from 'vitest';

import type {
  ApplyContext,
  IRDocument,
  Pass,
  PassCategory,
  PassPhase,
  Pattern,
  SafetyLevel,
  StyleResolver,
} from '@domflax/core';
import {
  buildSelectorIndex,
  createNullResolver,
  createSyntheticSink,
  runPasses,
  syncClassesFromComputed,
} from '@domflax/core';
import { normalizer } from '@domflax/pattern-kit';
import { builtinPatterns } from '@domflax/patterns';
import { createTailwindResolver } from '@domflax/resolver-tailwind';

import { createHtmlBackend, createHtmlFrontend } from '../src/index';

/* ───────────────────────── pipeline harness (mirrors the real HTML pipeline) ───────────────────────── */

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
  const { doc } = createHtmlFrontend().parse(code, {
    id: 'index.html',
    kind: 'html',
    resolver,
    normalizer,
    config: {},
    onDiagnostic: () => {},
  });
  return doc;
}

/** Run the full HTML pipeline: parse → runPasses(provably-safe) → reverse-emit → surgical print. */
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
  return createHtmlBackend().print(
    optimized,
    { moduleId: 'index.html', ops: [], provenance: new Map() },
    { normalizer, resolver, sink: createSyntheticSink(), eol: '\n', onDiagnostic: () => {} },
  ).code;
}

/* ───────────────────────── round-trip (byte-for-byte) ───────────────────────── */

const DOC = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <!-- a comment: keep me verbatim -->
    <style>.a{color:red}</style>
    <title>Hi</title>
  </head>
  <body>
    <p>Plain paragraph with   irregular    whitespace.</p>
    <script>const x = 1 < 2 && 3 > 1;</script>
  </body>
</html>
`;

describe('html frontend/backend — round-trip', () => {
  it('returns a document with no optimizable content BYTE-FOR-BYTE unchanged', () => {
    // Null resolver ⇒ nothing resolves ⇒ no compress/flatten ⇒ pure passthrough.
    expect(optimize(DOC, createNullResolver())).toBe(DOC);
  });

  it('preserves doctype, comments, whitespace, <style>/<script> even under the real Tailwind resolver', () => {
    // These have no compressible/flattenable Tailwind classes, so the output must still be identical.
    expect(optimize(DOC, createTailwindResolver())).toBe(DOC);
  });
});

/* ───────────────────────── compress (class-only, in place) ───────────────────────── */

describe('html frontend/backend — compress', () => {
  it('collapses px-4 py-4 → p-4 in the class VALUE span, leaving everything else verbatim', () => {
    const tw = createTailwindResolver();
    const out = optimize('<div class="px-4 py-4">x</div>', tw);
    expect(out).toBe('<div class="p-4">x</div>');
  });

  it('compresses inside a full document without disturbing surrounding bytes', () => {
    const tw = createTailwindResolver();
    const src = `<!DOCTYPE html>\n<body>\n  <div class="px-4 py-4">x</div>\n</body>\n`;
    const out = optimize(src, tw);
    expect(out).toBe(`<!DOCTYPE html>\n<body>\n  <div class="p-4">x</div>\n</body>\n`);
  });
});

/* ───────────────────────── inert flatten (display:contents wrapper) ───────────────────────── */

describe('html frontend/backend — inert flatten', () => {
  it('removes a display:contents wrapper, keeping the child verbatim', () => {
    const tw = createTailwindResolver();
    const out = optimize('<div class="contents"><a class="text-blue-500">L</a></div>', tw);
    expect(out).toBe('<a class="text-blue-500">L</a>');
  });
});

/* ───────────────────────── opaque preservation ───────────────────────── */

describe('html frontend/backend — opaque preservation', () => {
  it('never rewrites an element with an id, an inline handler, or inside a <script>', () => {
    const tw = createTailwindResolver();
    // Every div here carries compressible px-4 py-4, but each is opaque and must stay untouched:
    //  - #keep has an id (JS querySelector hook)
    //  - the onclick div has an inline event handler
    //  - the <script> subtree is never descended into
    const src =
      `<div id="keep" class="px-4 py-4">a</div>` +
      `<div onclick="go()" class="px-4 py-4">b</div>` +
      `<script>const s = "px-4 py-4";</script>`;
    expect(optimize(src, tw)).toBe(src);
  });

  it('still compresses a NON-opaque sibling of opaque elements', () => {
    const tw = createTailwindResolver();
    const src = `<div id="keep" class="px-4 py-4">a</div><span class="px-4 py-4">b</span>`;
    const out = optimize(src, tw);
    expect(out).toBe(`<div id="keep" class="px-4 py-4">a</div><span class="p-4">b</span>`);
  });
});
