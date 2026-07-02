/**
 * domflax — the single-file JSX/TSX pipeline runner (parse → resolve → flatten → reverse-emit →
 * print), split out of `index.ts` so the meta package's barrel + adapters stay focused.
 *
 * {@link runJsxPipeline} is SYNC and fully static (gate `'provably-safe'`): it never changes rendering
 * and never launches a browser.
 */

import {
  buildSelectorIndex,
  createSyntheticSink,
  runPasses,
  syncClassesFromComputed,
} from '@domflax/core';
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
import { createHtmlBackend, createHtmlFrontend } from '@domflax/frontend-html';
import { createJsxBackend, createJsxFrontend } from '@domflax/frontend-jsx';
import { normalizer } from '@domflax/pattern-kit';

import type { FileStatDelta } from './summary';

/** Output of a pipeline run: the printed code plus the per-file optimization delta. */
export interface PipelineOutput {
  readonly code: string;
  readonly stats: FileStatDelta;
}

/** UTF-8 byte length (matches the CLI's `bytes()` — bytesSaved is measured in real bytes). */
function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Rough class-token count (provider-independent, string-level) — identical to the CLI's
 * `countClassTokens`, so both surfaces report the same "classes compressed" figure.
 */
function countClassTokens(code: string): number {
  let total = 0;
  const re = /\b(?:className|class)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    total += m[1]!.split(/\s+/).filter((t) => t.length > 0).length;
  }
  return total;
}

/**
 * Compute the per-file stat delta the same way the CLI's `finish()` does: nodes from the IR
 * node-count delta, classes from the class-token delta, bytes from the UTF-8 byte-length delta.
 */
function computeStats(code: string, out: string, nodesIn: number, nodesOut: number): FileStatDelta {
  const classesBefore = countClassTokens(code);
  const classesAfter = countClassTokens(out);
  return {
    nodesRemoved: Math.max(0, nodesIn - nodesOut),
    classesSaved: Math.max(0, classesBefore - classesAfter),
    bytesSaved: bytes(code) - bytes(out),
  };
}

/** `.tsx`/`.jsx` ⇒ the matching {@link FileKind}; anything else ⇒ null (no JSX frontend). */
export function jsxKindOf(id: string): FileKind | null {
  const clean = id.split('?', 1)[0] ?? id;
  if (clean.endsWith('.tsx')) return 'tsx';
  if (clean.endsWith('.jsx')) return 'jsx';
  return null;
}

/** `.html`/`.htm` ⇒ `'html'`; anything else ⇒ null (no HTML frontend). */
export function htmlKindOf(id: string): FileKind | null {
  const clean = (id.split('?', 1)[0] ?? id).toLowerCase();
  if (clean.endsWith('.html') || clean.endsWith('.htm')) return 'html';
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

/** The parsed, authorized doc + the apply context + grouped passes, shared by sync + async runs. */
interface PreparedRun {
  readonly doc: IRDocument;
  readonly ctx: ApplyContext;
  readonly passes: readonly Pass[];
}

/** PARSE (JSX → IR, resolving classes onto `computed`) + AUTHORIZE + build the apply context. */
function preparePipeline(
  code: string,
  id: string,
  kind: FileKind,
  resolver: StyleResolver,
  patterns: readonly Pattern[],
  safety: SafetyLevel,
  gate: FlattenGate,
): PreparedRun {
  const parsed = createJsxFrontend().parse(code, {
    id,
    kind,
    resolver,
    normalizer,
    config: {},
    onDiagnostic: () => {},
  });
  const doc = parsed.doc;

  // AUTHORIZE — the JSX frontend defaults every node's safety floor to 0. The orchestrator opens the
  // floor to the max; the configured ceiling + each pattern's opacity predicates are the real gate.
  for (const node of doc.nodes.values()) node.meta.safetyFloor = 3;

  const ctx: ApplyContext = {
    doc,
    safetyCeiling: safety,
    normalizer,
    // Real CSS-selector-safety index from the active resolver: a wrapper a combinator/structural
    // selector depends on is flagged so the flatten guards refuse to flatten it. Tailwind (no
    // complexSelectors) degrades to the null index — behaviour unchanged.
    selectors: buildSelectorIndex(doc, resolver),
    resolver,
    gate,
  };
  return { doc, ctx, passes: buildPasses(patterns) };
}

/** REVERSE-EMIT optimized computed styles back into class tokens, then PRINT IR → JSX/TSX text. */
function finishPipeline(optimized: IRDocument, id: string, resolver: StyleResolver): string {
  syncClassesFromComputed(optimized, resolver, normalizer);
  const printed = createJsxBackend().print(
    optimized,
    { moduleId: id, ops: [], provenance: new Map() },
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

/** SYNC full pipeline (gate `'provably-safe'` — never changes rendering, never launches a browser). */
export function runJsxPipeline(
  code: string,
  id: string,
  kind: FileKind,
  resolver: StyleResolver,
  patterns: readonly Pattern[],
  safety: SafetyLevel,
): PipelineOutput {
  const { doc, ctx, passes } = preparePipeline(code, id, kind, resolver, patterns, safety, 'provably-safe');
  const nodesIn = doc.nodes.size;
  const { doc: optimized } = runPasses(doc, passes, ctx);
  const out = finishPipeline(optimized, id, resolver);
  return { code: out, stats: computeStats(code, out, nodesIn, optimized.nodes.size) };
}

/* ───────────────────────── HTML pipeline (parse5 frontend/backend) ───────────────────────── */

/**
 * PARSE (HTML → IR, resolving classes onto `computed`) + AUTHORIZE + build the apply context. Unlike
 * the JSX path, the HTML frontend sets per-node `safetyFloor` itself (opaque nodes → 0), so we must
 * NOT blanket-open every node to 3 (that would strip the opacity floors).
 */
function prepareHtml(
  code: string,
  id: string,
  resolver: StyleResolver,
  patterns: readonly Pattern[],
  safety: SafetyLevel,
  gate: FlattenGate,
): PreparedRun {
  const parsed = createHtmlFrontend().parse(code, {
    id,
    kind: 'html',
    resolver,
    normalizer,
    config: {},
    onDiagnostic: () => {},
  });
  const doc = parsed.doc;
  const ctx: ApplyContext = {
    doc,
    safetyCeiling: safety,
    normalizer,
    selectors: buildSelectorIndex(doc, resolver),
    resolver,
    gate,
  };
  return { doc, ctx, passes: buildPasses(patterns) };
}

/** REVERSE-EMIT optimized computed styles back into class tokens, then PRINT IR → HTML text. */
function finishHtmlPipeline(optimized: IRDocument, id: string, resolver: StyleResolver): string {
  syncClassesFromComputed(optimized, resolver, normalizer);
  const printed = createHtmlBackend().print(
    optimized,
    { moduleId: id, ops: [], provenance: new Map() },
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

/** SYNC full HTML pipeline (gate `'provably-safe'` — surgical span edits over verbatim source). */
export function runHtmlPipeline(
  code: string,
  id: string,
  resolver: StyleResolver,
  patterns: readonly Pattern[],
  safety: SafetyLevel,
): PipelineOutput {
  const { doc, ctx, passes } = prepareHtml(code, id, resolver, patterns, safety, 'provably-safe');
  const nodesIn = doc.nodes.size;
  const { doc: optimized } = runPasses(doc, passes, ctx);
  const out = finishHtmlPipeline(optimized, id, resolver);
  return { code: out, stats: computeStats(code, out, nodesIn, optimized.nodes.size) };
}
