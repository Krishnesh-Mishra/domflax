/**
 * @domflax/frontend-html — parse5 HTML <-> IR frontend + backend (TYPED STUB).
 *
 * Role: a {@link Frontend} that parses HTML source into an {@link IRDocument}, and a matching
 * {@link Backend} that prints an edited IR document back to HTML with surgical, span-based edits.
 *
 * This is a Stage-N stub: the public surface (names, langs, signatures) is final and typechecks
 * against the @domflax/core contract under strict + verbatimModuleSyntax, but the heavy lifting —
 * the parse5 tree walk into IR and the reverse codegen — throws `NotImplemented`. Trivial bits
 * (capability predicates, honest passthroughs) are implemented for real.
 *
 * FUTURE DEP: parse5 (HTML5-spec tree construction + serialization). Intentionally NOT in
 * package.json yet — stubs must not pull heavy third-party libs. The real implementation will:
 *   - frontend: parse5.parse(code) → walk the parse5 tree → IRElement/IRText/IRComment nodes,
 *     resolve class/inline-style via ctx.resolver/ctx.normalizer, populate the BackrefTable from
 *     parse5 location info (sourceCodeLocationInfo: true).
 *   - backend: apply the EditPlan's RewriteOps as TextEdits against retained verbatim source,
 *     falling back to parse5 serialization for synthetic subtrees.
 */

import type {
  Backend,
  BackendContext,
  CodegenResult,
  EditPlan,
  FileKind,
  Frontend,
  FrontendParseContext,
  IRDocument,
  ParseResult,
} from '@domflax/core';

/** File kinds this frontend/backend handles. */
const HTML_LANGS: readonly FileKind[] = ['html'];

/** Lightweight heuristic: does this source id / code look like HTML we can own? */
function looksLikeHtml(id: string, code: string): boolean {
  if (/\.html?$/i.test(id)) return true;
  // <!doctype html> or a leading tag-open are strong HTML signals.
  const head = code.slice(0, 256).trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<');
}

/**
 * HTML frontend: parse5 HTML → IR. STUB — `parse` throws NotImplemented; `canParse` is real.
 */
export const htmlFrontend: Frontend = {
  name: 'html',
  langs: HTML_LANGS,

  canParse(id: string, code: string): boolean {
    return looksLikeHtml(id, code);
  },

  parse(_code: string, _ctx: FrontendParseContext): ParseResult {
    throw new Error('NotImplemented: parse5 HTML→IR parsing lands in Stage N (frontend-html)');
  },
};

/**
 * HTML backend: IR → HTML via span-based surgical edits (+ parse5 serialization for synthetic
 * subtrees). STUB — `print` throws NotImplemented; `name`/`langs` are real.
 */
export const htmlBackend: Backend = {
  name: 'html',
  langs: HTML_LANGS,

  print(_doc: IRDocument, _plan: EditPlan, _ctx: BackendContext): CodegenResult {
    throw new Error('NotImplemented: IR→HTML codegen lands in Stage N (frontend-html)');
  },
};

export default htmlFrontend;
