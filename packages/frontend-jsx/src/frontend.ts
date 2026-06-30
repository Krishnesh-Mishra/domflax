/**
 * @domflax/frontend-jsx — Babel JSX/TSX → IR frontend.
 *
 * Walks a Babel AST (`@babel/parser` → `@babel/traverse`) and lowers JSXElement /
 * JSXFragment / JSXText / JSXExpressionContainer / JSXSpreadChild nodes into the
 * `@domflax/core` IR. ALL dynamic JavaScript stays out of the structural IR: every
 * expression container, spread, and dynamic className/child is interned into the
 * document's {@link ExprRegistry} as an opaque {@link ExprRef} (with its verbatim source
 * slice as payload), and only its source span survives in the tree.
 *
 * Static `class`/`className` literals are split into {@link ClassToken}s on a static
 * {@link ClassSegment}; a non-string-literal className becomes a single dynamic segment
 * (opaque, never optimized). Static classes are resolved through the supplied
 * {@link StyleResolver} + {@link StyleNormalizer} into `element.computed` so downstream
 * patterns can match on resolved style.
 *
 * NodeMeta opacity barriers populated here: hasRef (`ref=`), hasEventHandlers (`on*=`),
 * hasKey (`key=`), hasSpreadAttrs (`{...x}`), hasDangerousHtml
 * (`dangerouslySetInnerHTML=`), hasDynamicChildren (any expression / spread child),
 * isComponent (capitalized / member tag). "hasDynamicClasses" is carried on the
 * {@link ClassList} itself (`hasDynamic` / `opaque`), not on NodeMeta.
 *
 * The pure AST/classification helpers live in `./frontend-ast`; the parse pass itself
 * lives in `./frontend-parse`. This module is the public assembly point.
 */

import type { Frontend, FrontendParseContext, ParseResult } from '@domflax/core';

import { JSX_LANGS, looksLikeJsx } from './frontend-ast';
import { doParse } from './frontend-parse';

export const jsxFrontend: Frontend = {
  name: 'babel-jsx',
  langs: JSX_LANGS,
  canParse(id: string, code: string): boolean {
    return looksLikeJsx(id, code);
  },
  parse(code: string, ctx: FrontendParseContext): ParseResult {
    return doParse(code, ctx);
  },
};

/** Factory mirror — returns a fresh handle to the (stateless) JSX frontend. */
export function createJsxFrontend(): Frontend {
  return jsxFrontend;
}
