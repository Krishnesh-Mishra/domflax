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
  ClassList,
  ClassSegment,
  ClassToken,
  ConditionKey,
  CssProperty,
  EmitContext,
  FileKind,
  IRDocument,
  Pass,
  PassCategory,
  PassPhase,
  Pattern,
  SafetyLevel,
  StyleBlock,
  StyleDecl,
  StyleMap,
  StyleNormalizer,
  StyleResolver,
} from '@domflax/core';
import {
  BASE_CONDITION,
  conditionKey,
  createNullSelectorIndex,
  createSyntheticSink,
  elementIds,
  emptyStyleMap,
  getElement,
  runPasses,
} from '@domflax/core';
import { createJsxBackend, createJsxFrontend } from '@domflax/frontend-jsx';
import type { AuthoredPattern } from '@domflax/pattern-kit';
import { normalizer } from '@domflax/pattern-kit';
import { runAutoTests, runInvariants } from '@domflax/pattern-kit/testing';
import { createTailwindResolver } from '@domflax/resolver-tailwind';

import { builtinPatterns } from './index';

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

/** The BASE-condition declaration map of a StyleMap (empty when absent). */
function baseDecls(sm: StyleMap): ReadonlyMap<CssProperty, StyleDecl> {
  return sm.blocks.get(conditionKey(BASE_CONDITION))?.decls ?? new Map<CssProperty, StyleDecl>();
}

/** The BASE-condition declarations present in `current` but not equal-valued in `original`. */
function residualStyleMap(current: StyleMap, original: StyleMap): StyleMap {
  const orig = baseDecls(original);
  const decls = new Map<CssProperty, StyleDecl>();
  for (const [prop, decl] of baseDecls(current)) {
    const had = orig.get(prop);
    if (!had || had.value !== decl.value) decls.set(prop, decl);
  }
  if (decls.size === 0) return emptyStyleMap();
  const block: StyleBlock = { condition: BASE_CONDITION, decls };
  return { blocks: new Map<ConditionKey, StyleBlock>([[conditionKey(BASE_CONDITION), block]]) };
}

/** All static class tokens of a ClassList, in order. */
function staticTokensOf(cl: ClassList): string[] {
  const out: string[] = [];
  for (const seg of cl.segments) {
    if (seg.kind === 'static') for (const t of seg.tokens) out.push(t.value);
  }
  return out;
}

/** A rewritable static {@link ClassList} over `tokens`, preserving the previous list's spans. */
function staticClassList(prev: ClassList, tokens: readonly string[]): ClassList {
  const classTokens: ClassToken[] = tokens.map((value) => ({ value }));
  const seg: ClassSegment = { kind: 'static', tokens: classTokens };
  return {
    form: 'string-literal',
    segments: [seg],
    valueSpan: prev.valueSpan,
    attrSpan: prev.attrSpan,
    hasDynamic: false,
    opaque: false,
    rewritable: true,
  };
}

/** Fold optimized computed styles back into class tokens for every TOUCHED, rewritable element. */
function syncClassesFromComputed(
  doc: IRDocument,
  resolver: StyleResolver,
  norm: StyleNormalizer,
): void {
  const sink = createSyntheticSink();
  for (const id of elementIds(doc)) {
    const el = getElement(doc, id);
    if (!el || !el.meta.touched) continue;
    if (el.classes.opaque || el.classes.hasDynamic) continue;

    const tokens = staticTokensOf(el.classes);
    const original = norm.normalizeStyleMap(
      resolver.resolve({
        classes: tokens,
        element: { tagName: el.tag, namespace: el.namespace === 'svg' ? 'svg' : 'html' },
      }).styles,
    );
    const residual = residualStyleMap(el.computed, original);
    if (baseDecls(residual).size === 0) continue;

    const ctx: EmitContext = { normalizer: norm, sink };
    const emitted = resolver.emit(residual, ctx).classes;
    if (emitted.length === 0) continue;

    const next = [...tokens];
    for (const c of emitted) if (!next.includes(c)) next.push(c);
    el.classes = staticClassList(el.classes, next);
  }
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
