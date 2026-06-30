/**
 * @domflax/patterns — the SINGLE generic pattern test file.
 *
 * Replaces every per-pattern hand-written test. It drives the two suites shipped by
 * `@domflax/pattern-kit/testing`:
 *
 *   • {@link runInvariants} — a pure IR-level suite (purity, opacity-barrier safety, id-preserving
 *     unwrap, safety-ceiling, fixpoint convergence) needing only `@domflax/core`.
 *   • {@link runAutoTests} — drives every authored `example` through a REAL transform built here
 *     from the lower packages directly (JSX frontend → Tailwind resolver onto computed → core pass
 *     manager running `builtinPatterns` → reverse-emit → JSX backend print). It does NOT import
 *     `domflax`/`@domflax/domflax` (that would be a dependency cycle); it re-implements the thin
 *     orchestration glue (pass grouping + reverse class emit) locally.
 */

import type {
  ApplyContext,
  FileKind,
  IRDocument,
  Pass,
  PassCategory,
  PassPhase,
  Pattern,
  SafetyLevel,
  StyleResolver,
} from '@domflax/core';
import {
  createNullSelectorIndex,
  createSyntheticSink,
  runPasses,
  syncClassesFromComputed,
} from '@domflax/core';
import { createJsxBackend, createJsxFrontend } from '@domflax/frontend-jsx';
import type { AuthoredPattern } from '@domflax/pattern-kit';
import { normalizer } from '@domflax/pattern-kit';
import { runAutoTests, runInvariants } from '@domflax/pattern-kit/testing';
import { createTailwindResolver } from '@domflax/resolver-tailwind';

import { describe, expect, it } from 'vitest';

import { builtinPatterns } from './_registry.generated';

/* ───────────────────────── orchestration glue (mirrors domflax, sans the cycle) ───────────────────────── */

/** `.tsx`/`.jsx` ⇒ the matching {@link FileKind}; anything else ⇒ null. */
function jsxKindOf(id: string): FileKind | null {
  if (id.endsWith('.tsx')) return 'tsx';
  if (id.endsWith('.jsx')) return 'jsx';
  return null;
}

/** First registered source's EOL, defaulting to `\n`. */
function eolOf(doc: IRDocument): '\n' | '\r\n' {
  for (const src of doc.sources.values()) return src.eol;
  return '\n';
}

/** Group the flat pattern list into one {@link Pass} per {@link PassPhase} (derived from category). */
function buildPasses(patterns: readonly Pattern[]): Pass[] {
  const byPhase = new Map<PassPhase, Pattern[]>();
  for (const p of patterns) {
    const phase = (p.category.split('/', 1)[0] ?? 'flatten') as PassPhase;
    let bucket = byPhase.get(phase);
    if (!bucket) {
      bucket = [];
      byPhase.set(phase, bucket);
    }
    bucket.push(p);
  }
  const passes: Pass[] = [];
  for (const [phase, pats] of byPhase) {
    passes.push({ phase, category: `${phase}/builtin` as PassCategory, patterns: pats });
  }
  return passes;
}

/* ───────────────────────── the transform under test ───────────────────────── */

const resolver: StyleResolver = createTailwindResolver();
const SAFETY: SafetyLevel = 3;

/**
 * Full single-file JSX/TSX transform: parse → resolve onto computed → run `builtinPatterns` to a
 * fixpoint → reverse-emit class tokens → re-print. Non-jsx/tsx input is returned unchanged.
 */
function transform(code: string, filename: string): string {
  const kind = jsxKindOf(filename);
  if (kind === null) return code;

  // 1. PARSE — frontend lowers JSX → IR and resolves static classes onto `el.computed`.
  const parsed = createJsxFrontend().parse(code, {
    id: filename,
    kind,
    resolver,
    normalizer,
    config: {},
    onDiagnostic: () => {},
  });
  const doc = parsed.doc;

  // 2. AUTHORIZE — open every node's safety floor so the configured ceiling + each pattern's own
  //    opacity predicates are the real gate.
  for (const node of doc.nodes.values()) node.meta.safetyFloor = 3;

  // 3. PASSES — drive the built-in patterns to a fixpoint.
  const ctx: ApplyContext = {
    doc,
    safetyCeiling: SAFETY,
    normalizer,
    selectors: createNullSelectorIndex(),
    resolver,
  };
  const { doc: optimized } = runPasses(doc, buildPasses(builtinPatterns), ctx);

  // 4. REVERSE-EMIT — fold optimized computed styles back into class tokens.
  syncClassesFromComputed(optimized, resolver, normalizer);

  // 5. PRINT — IR → JSX/TSX text.
  const printed = createJsxBackend().print(
    optimized,
    { moduleId: filename, ops: [], provenance: new Map() },
    {
      normalizer,
      resolver,
      sink: createSyntheticSink(),
      eol: eolOf(optimized),
      onDiagnostic: () => {},
    },
  );
  return printed.code;
}

/* ───────────────────────── the two generated suites ───────────────────────── */

const patterns = builtinPatterns as readonly AuthoredPattern[];

runInvariants(patterns);
runAutoTests(patterns, { transform });

/* ───────────────────────── auto-discovered registry shape ───────────────────────── */

describe('builtinPatterns registry (auto-generated)', () => {
  it('auto-discovers patterns with unique names', () => {
    const names = builtinPatterns.map((p) => p.name);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
  });

  it('is ordered flatten-before-compress (sorted by category phase)', () => {
    const phases = builtinPatterns.map((p) => p.category.split('/', 1)[0]);
    const lastFlatten = phases.lastIndexOf('flatten');
    const firstCompress = phases.indexOf('compress');
    // Every flatten pattern must precede every compress pattern.
    expect(lastFlatten).toBeLessThan(firstCompress);
    expect(phases.every((ph) => ph === 'flatten' || ph === 'compress')).toBe(true);
  });
});
