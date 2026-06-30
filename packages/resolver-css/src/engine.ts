import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { Root as PostcssRoot } from 'postcss';
import type selectorParser from 'postcss-selector-parser';

/* ────────────────────────────────────────────────────────────────────────── *
 * Lazy engine loading (postcss + postcss-selector-parser)
 * ────────────────────────────────────────────────────────────────────────── *
 *
 * postcss and postcss-selector-parser are OPTIONAL peers of the published `domflax` package: a
 * Tailwind-only user need not install them. They must therefore be loaded LAZILY (only when this
 * resolver is actually constructed) and from the CONSUMER'S project — never via a static top-level
 * `import`, which would (a) crash on module load for a postcss-less install and (b), once this
 * resolver is inlined into domflax's bundle, resolve relative to `domflax/dist` instead of the
 * user's project. We root the require in `process.cwd()` (or an explicit project root), exactly as
 * the Tailwind resolver does, with the bundle/source location as a last-resort fallback.
 */

/** This module's own location — esbuild fills `__filename` in CJS; ESM falls back to `import.meta.url`. */
export function moduleBase(): string {
  return typeof __filename === 'string' ? __filename : import.meta.url;
}

/** The single postcss entry point this resolver calls at runtime. */
export type PostcssParseApi = (css: string, opts?: { from?: string }) => PostcssRoot;

/** The subset of the postcss-selector-parser API this resolver calls at runtime (guards preserve narrowing). */
export interface SelectorParserApi {
  (): { astSync(selector: string): selectorParser.Root };
  isClassName(n: selectorParser.Node): n is selectorParser.ClassName;
  isTag(n: selectorParser.Node): n is selectorParser.Tag;
  isIdentifier(n: selectorParser.Node): n is selectorParser.Identifier;
  isAttribute(n: selectorParser.Node): n is selectorParser.Attribute;
  isUniversal(n: selectorParser.Node): n is selectorParser.Universal;
  isNesting(n: selectorParser.Node): n is selectorParser.Nesting;
  isPseudo(n: selectorParser.Node): n is selectorParser.Pseudo;
  isPseudoClass(n: selectorParser.Node): n is selectorParser.Pseudo;
  isPseudoElement(n: selectorParser.Node): n is selectorParser.Pseudo;
  isCombinator(n: selectorParser.Node): n is selectorParser.Combinator;
}

export interface PostcssEngine {
  readonly parse: PostcssParseApi;
  readonly selectorParser: SelectorParserApi;
}

/** Resolve postcss + postcss-selector-parser from the consumer's project; `null` if unavailable. */
export function loadPostcssEngine(projectRoot?: string): PostcssEngine | null {
  const bases: string[] = [];
  if (projectRoot) bases.push(path.join(projectRoot, '__domflax__.js'));
  bases.push(path.join(process.cwd(), '__domflax__.js'));
  bases.push(moduleBase());
  for (const base of bases) {
    try {
      const req = createRequire(base);
      req.resolve('postcss');
      req.resolve('postcss-selector-parser');
      const postcss = req('postcss') as { parse: PostcssParseApi };
      const raw = req('postcss-selector-parser') as SelectorParserApi & { default?: SelectorParserApi };
      // postcss-selector-parser is CJS with a default export under interop; accept both shapes.
      const selector = raw.default ?? raw;
      return { parse: postcss.parse, selectorParser: selector };
    } catch {
      /* try the next base */
    }
  }
  return null;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Lazily-loaded postcss engine (module singleton)
 * ────────────────────────────────────────────────────────────────────────── */

/** Runtime postcss `parse`, populated on first resolver construction. */
export let pc: PostcssParseApi | null = null;
/** Runtime postcss-selector-parser, populated on first resolver construction. */
export let sp: SelectorParserApi | null = null;

/** Ensure the postcss engine is loaded; throws a clear error if the optional peers are absent. */
export function ensurePostcss(projectRoot?: string): void {
  if (pc && sp) return;
  const engine = loadPostcssEngine(projectRoot);
  if (!engine) {
    throw new Error(
      '@domflax/resolver-css requires "postcss" and "postcss-selector-parser" to be installed in ' +
        'your project (they are optional peer dependencies of domflax, loaded only when the custom-CSS ' +
        'provider is used). Install them with: npm install postcss postcss-selector-parser',
    );
  }
  pc = engine.parse;
  sp = engine.selectorParser;
}
