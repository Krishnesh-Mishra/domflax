/**
 * @domflax/patterns — the SINGLE generic pattern test file.
 *
 * Replaces every per-pattern hand-written test. Each pattern is authored as ONE declarative
 * `definePattern({ …, test })` call; this file reads each pattern's co-located `.test` and drives
 * two suites shipped by `@domflax/pattern-kit/testing`:
 *
 *   • {@link runInvariants} — a pure IR-level suite (purity, opacity-barrier safety, id-preserving
 *     unwrap, safety-ceiling, fixpoint convergence) needing only `@domflax/core`. It exercises every
 *     pattern's rewrite ops directly (independent of the flatten gate), so the centering/merge
 *     flattens — which the conservative gate below intentionally does NOT commit — still have their
 *     op-level correctness asserted.
 *   • {@link runAutoTests} — for each pattern builds a REAL transform for its declared `provider`
 *     (default `tailwind`; `custom` resolves the listed `cssFiles`) and runs every `case`
 *     (`before → after`), every `noMatch` (left unchanged), and any `custom` hook.
 *
 * The transform mirrors PRODUCTION (`domflax`'s sync pipeline / the CLI): it runs under the
 * conservative `gate: 'provably-safe'` flatten policy, so only provably layout-neutral flattens
 * commit. A centering wrapper (`display:flex; …center`) establishes a formatting context, so it is a
 * `needs-verification` flatten and is correctly left UNCHANGED — those patterns' `test.noMatch` cases
 * assert exactly that. It does NOT import `domflax`/`@domflax/domflax` (that would be a dependency
 * cycle); it re-implements the thin orchestration glue (pass grouping + reverse class emit) locally.
 */

import type {
  ApplyContext,
  FileKind,
  FlattenGate,
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
import { runAutoTests, runInvariants, type Transform } from '@domflax/pattern-kit/testing';
import { createTailwindResolver } from '@domflax/resolver-tailwind';
import { createCssResolver } from '@domflax/resolver-css';

import { describe, expect, it } from 'vitest';

import { builtinPatterns } from '../src/_registry.generated';

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

const SAFETY: SafetyLevel = 3;
/** Mirror production: only provably layout-neutral flattens commit (never changes rendering). */
const GATE: FlattenGate = 'provably-safe';

/**
 * Full single-file JSX/TSX transform bound to one {@link StyleResolver}: parse → resolve onto
 * computed → run `builtinPatterns` to a fixpoint (under the conservative gate) → reverse-emit class
 * tokens → re-print. Non-jsx/tsx input is returned unchanged.
 */
function makeTransform(resolver: StyleResolver): Transform {
  return (code: string, filename: string): string => {
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
    //    opacity predicates + the flatten gate are the real gate.
    for (const node of doc.nodes.values()) node.meta.safetyFloor = 3;

    // 3. PASSES — drive the built-in patterns to a fixpoint under the conservative flatten gate.
    const ctx: ApplyContext = {
      doc,
      safetyCeiling: SAFETY,
      normalizer,
      selectors: createNullSelectorIndex(),
      resolver,
      gate: GATE,
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
  };
}

/* ───────────────────────── per-provider transform selection ───────────────────────── */

const tailwindTransform: Transform = makeTransform(createTailwindResolver());

/** Cache custom-CSS transforms by the (joined) stylesheet set so each is built at most once. */
const customTransforms = new Map<string, Transform>();

function customTransformFor(cssFiles: readonly string[]): Transform {
  const key = [...cssFiles].sort().join('|');
  let t = customTransforms.get(key);
  if (!t) {
    t = makeTransform(createCssResolver([], { files: [...cssFiles] }));
    customTransforms.set(key, t);
  }
  return t;
}

/** Pick the transform a pattern's co-located tests run through, based on its declared provider. */
function transformFor(p: AuthoredPattern): Transform {
  const provider = p.test?.provider ?? 'tailwind';
  if (provider === 'custom') return customTransformFor(p.test?.cssFiles ?? []);
  return tailwindTransform;
}

/* ───────────────────────── the two generated suites ───────────────────────── */

const patterns = builtinPatterns as readonly AuthoredPattern[];

runInvariants(patterns);
runAutoTests(patterns, { transformFor });

/* ───────────────────────── auto-discovered registry shape ───────────────────────── */

describe('builtinPatterns registry (auto-generated)', () => {
  it('auto-discovers patterns with unique names', () => {
    const names = builtinPatterns.map((p) => p.name);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every pattern co-locates a test spec', () => {
    for (const p of patterns) {
      expect(p.test, `${p.name} must declare a co-located test`).toBeDefined();
      const hasCases = (p.test?.cases?.length ?? 0) > 0;
      const hasNoMatch = (p.test?.noMatch?.length ?? 0) > 0;
      const hasCustom = typeof p.test?.custom === 'function';
      expect(hasCases || hasNoMatch || hasCustom, `${p.name} declares at least one case`).toBe(true);
    }
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
