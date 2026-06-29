/**
 * @domflax/frontend-jsx — Babel JSX → IR frontend (TYPED STUB, Stage 1).
 *
 * The real implementation walks a Babel AST (`@babel/parser` → `@babel/traverse`)
 * and lowers JSXElement / JSXFragment / JSXText / JSXExpressionContainer nodes into
 * the `@domflax/core` IR, resolving class/inline styles through the supplied
 * `StyleResolver` + `StyleNormalizer` and recording backref spans for surgical codegen.
 *
 * Future deps (NOT yet in package.json — heavy, land in Stage 1):
 *   @babel/parser, @babel/types, @babel/traverse, magic-string
 */

import type {
  FileKind,
  Frontend,
  FrontendParseContext,
  ParseResult,
} from '@domflax/core';

/** Languages this frontend claims. JSX/TSX only; HTML is owned by a sibling frontend. */
const JSX_LANGS: readonly FileKind[] = ['jsx', 'tsx'];

/**
 * Cheap, allocation-light heuristic so the orchestrator can route a file without
 * paying for a full Babel parse. Real `parse` lands in Stage 1.
 */
function looksLikeJsx(id: string, code: string): boolean {
  if (/\.[jt]sx$/i.test(id)) return true;
  // A bare `<Tag` / `</Tag` / `<>` opener is a strong JSX signal.
  return /<\/?[A-Za-z][\w.-]*|<>/.test(code);
}

export const jsxFrontend: Frontend = {
  name: 'babel-jsx',
  langs: JSX_LANGS,

  canParse(id: string, code: string): boolean {
    return looksLikeJsx(id, code);
  },

  parse(_code: string, _ctx: FrontendParseContext): ParseResult {
    throw new Error('NotImplemented: Babel JSX → IR lowering lands in Stage 1');
  },
};

/** Factory mirror — lets callers obtain a fresh instance (config wiring lands in Stage 1). */
export function createJsxFrontend(): Frontend {
  return jsxFrontend;
}
