/**
 * @domflax/cli — the single-file transform engine.
 *
 * Built directly from the LOWER packages (core + frontend-jsx + resolver-tailwind/resolver-css +
 * patterns + pattern-kit). It deliberately does NOT import the `domflax` meta package: domflax's bin
 * imports `@domflax/cli`, so importing domflax here would form a dependency cycle. The pipeline
 * mirrors domflax's own:  parse (JSX→IR, resolving each element's static classes through the chosen
 * resolver) → runPasses(builtinPatterns) → reverse-emit computed styles back to class tokens → print.
 *
 * Non-jsx/tsx files (including `.html`, which has no wired frontend yet) pass through unchanged.
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
  IRDocument,
  Pass,
  PassCategory,
  PassPhase,
  Pattern,
  SafetyLevel,
  StyleResolver,
} from '@domflax/core';
import { createJsxBackend, createJsxFrontend } from '@domflax/frontend-jsx';
import { normalizer } from '@domflax/pattern-kit';
import { builtinPatterns } from '@domflax/patterns';
import { createCssResolver } from '@domflax/resolver-css';
import { createTailwindResolver } from '@domflax/resolver-tailwind';

import type { CliOptions, ProviderOption } from './options';

/* ───────────────────────── per-file result + stats ───────────────────────── */

export interface FileStats {
  readonly nodesIn: number;
  readonly nodesOut: number;
  readonly nodesRemoved: number;
  readonly classesBefore: number;
  readonly classesAfter: number;
  readonly classesSaved: number;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  readonly bytesSaved: number;
}

export interface FileResult {
  readonly code: string;
  readonly changed: boolean;
  readonly passthrough: boolean;
  readonly stats: FileStats;
}

/** A configured transform — holds the resolver (and its cached engine) across files. */
export interface Transform {
  readonly resolver: StyleResolver;
  transformFile(code: string, id: string): FileResult;
}

/* ───────────────────────── resolver wiring ───────────────────────── */

/**
 * Build the {@link StyleResolver} for the chosen provider. The heavy engine each wraps (Tailwind v3 /
 * postcss) is loaded LAZILY at construction and resolved from the user's PROJECT via the factories'
 * `projectRoot` option — never from where the CLI bundle happens to live.
 */
export function buildResolver(provider: ProviderOption, css: readonly string[], projectRoot: string): StyleResolver {
  if (provider === 'custom') {
    return createCssResolver([], { files: css, projectRoot });
  }
  // 'auto' and 'tailwind' both resolve against the project's Tailwind engine.
  return createTailwindResolver({ projectRoot });
}

/* ───────────────────────── pass assembly ───────────────────────── */

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

/** Select the active patterns: every built-in unless the caller narrowed by name (the wizard does). */
function selectPatterns(names: readonly string[] | null): readonly Pattern[] {
  if (names === null) return builtinPatterns;
  const set = new Set(names);
  return builtinPatterns.filter((p) => set.has(p.name));
}

/* ───────────────────────── file kind + token counting ───────────────────────── */

/** `.tsx`/`.jsx` ⇒ the matching {@link FileKind}; anything else ⇒ null (no JSX frontend). */
function jsxKindOf(id: string): FileKind | null {
  const clean = id.split('?', 1)[0] ?? id;
  const lower = clean.toLowerCase();
  if (lower.endsWith('.tsx')) return 'tsx';
  if (lower.endsWith('.jsx')) return 'jsx';
  return null;
}

/** Rough class-token count for the `--report` summary (provider-independent, string-level). */
function countClassTokens(code: string): number {
  let total = 0;
  const re = /\b(?:className|class)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    total += m[1]!.split(/\s+/).filter((t) => t.length > 0).length;
  }
  return total;
}

function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function passthroughResult(code: string): FileResult {
  return {
    code,
    changed: false,
    passthrough: true,
    stats: {
      nodesIn: 0,
      nodesOut: 0,
      nodesRemoved: 0,
      classesBefore: 0,
      classesAfter: 0,
      classesSaved: 0,
      bytesBefore: bytes(code),
      bytesAfter: bytes(code),
      bytesSaved: 0,
    },
  };
}

/* ───────────────────────── the transform ───────────────────────── */

/**
 * Construct a transform for the given options. The resolver (and its engine) is built once and reused
 * across every file. With `provider: 'tailwind'|'auto'`, if Tailwind cannot be resolved from the
 * project the resolver degrades to resolving nothing — transforms then pass through unchanged.
 */
export function createTransform(options: CliOptions): Transform {
  const projectRoot = options.projectRoot ?? process.cwd();
  const resolver = buildResolver(options.provider, options.css, projectRoot);
  const patterns = selectPatterns(options.passes);

  return {
    resolver,
    transformFile(code: string, id: string): FileResult {
      const kind = jsxKindOf(id);
      if (kind === null) return passthroughResult(code);

      // 1. PARSE — JSX → IR; the frontend resolves each element's static classes into `el.computed`.
      const parsed = createJsxFrontend().parse(code, {
        id,
        kind,
        resolver,
        normalizer,
        config: {},
        onDiagnostic: () => {},
      });
      const doc = parsed.doc;
      const nodesIn = doc.nodes.size;

      // 2. AUTHORIZE — open every node's safety floor; the ceiling + pattern opacity guards gate.
      for (const node of doc.nodes.values()) node.meta.safetyFloor = 3;

      // 3. PASSES — drive the built-ins to a fixpoint via the core pass manager.
      const ctx: ApplyContext = {
        doc,
        safetyCeiling: options.safety as SafetyLevel,
        normalizer,
        // Real CSS-selector-safety index from the active resolver (custom-CSS reports combinator /
        // structural-pseudo coupling; Tailwind has none → null index, behaviour unchanged).
        selectors: buildSelectorIndex(doc, resolver),
        resolver,
      };
      const { doc: optimized } = runPasses(doc, buildPasses(patterns), ctx);

      // 4. REVERSE-EMIT — fold optimized computed styles back into class tokens.
      syncClassesFromComputed(optimized, resolver, normalizer);

      // 5. PRINT — IR → JSX/TSX text.
      const printed = createJsxBackend().print(
        optimized,
        { moduleId: id, ops: [], provenance: new Map() },
        {
          normalizer,
          resolver,
          sink: createSyntheticSink(),
          eol: '\n',
          onDiagnostic: () => {},
        },
      );

      const out = printed.code;
      const nodesOut = optimized.nodes.size;
      const classesBefore = countClassTokens(code);
      const classesAfter = countClassTokens(out);
      return {
        code: out,
        changed: out !== code,
        passthrough: false,
        stats: {
          nodesIn,
          nodesOut,
          nodesRemoved: Math.max(0, nodesIn - nodesOut),
          classesBefore,
          classesAfter,
          classesSaved: Math.max(0, classesBefore - classesAfter),
          bytesBefore: bytes(code),
          bytesAfter: bytes(out),
          bytesSaved: bytes(code) - bytes(out),
        },
      };
    },
  };
}

/** The names of every built-in pattern, for the wizard's multiselect. */
export function builtinPatternNames(): readonly string[] {
  return builtinPatterns.map((p) => p.name);
}
