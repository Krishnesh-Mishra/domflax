/**
 * @domflax/frontend-html — parse5 HTML <-> IR frontend + backend.
 *
 * A {@link Frontend} that parses HTML into an {@link IRDocument} (parse5 tree → IR, resolving each
 * element's `class` attribute onto `computed`), and a matching {@link Backend} that prints the edited
 * document back to HTML with SURGICAL, span-based edits over the original source (never re-serializing
 * the parse5 tree). Untouched bytes — doctype, comments, whitespace, scripts, attribute order — stay
 * byte-for-byte identical.
 *
 * parse5 is a real dependency but is LAZILY required inside `parse()` (see `./parse`), so the JSX-only
 * path never loads it. The parse walk + opacity/span helpers live in `./walk` + `./parse`; the reverse
 * codegen in `./backend`. This module is the public assembly point.
 */

import type {
  Backend,
  BackendContext,
  CodegenResult,
  EditPlan,
  Frontend,
  FrontendParseContext,
  IRDocument,
  ParseResult,
} from '@domflax/core';

import { doPrint } from './backend';
import { doParse } from './parse';
import { HTML_LANGS, looksLikeHtml } from './walk';

export { HTML_LANGS, looksLikeHtml } from './walk';

/** HTML frontend: parse5 HTML → IR (with source spans for surgical codegen). */
export const htmlFrontend: Frontend = {
  name: 'html',
  langs: HTML_LANGS,
  canParse(id: string, code: string): boolean {
    return looksLikeHtml(id, code);
  },
  parse(code: string, ctx: FrontendParseContext): ParseResult {
    return doParse(code, ctx);
  },
};

/** Factory mirror — returns a fresh handle to the (stateless) HTML frontend. */
export function createHtmlFrontend(): Frontend {
  return htmlFrontend;
}

/** HTML backend: IR → HTML via span-based surgical edits over the retained verbatim source. */
export const htmlBackend: Backend = {
  name: 'html',
  langs: HTML_LANGS,
  print(doc: IRDocument, _plan: EditPlan, _ctx: BackendContext): CodegenResult {
    return { code: doPrint(doc), map: null, edits: [], diagnostics: [] };
  },
};

/** Factory mirror — returns a fresh handle to the (stateless) HTML backend. */
export function createHtmlBackend(): Backend {
  return htmlBackend;
}

export default htmlFrontend;
