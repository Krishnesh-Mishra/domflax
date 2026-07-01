/**
 * @domflax/frontend-html — the parse5 HTML → IR parse pass.
 *
 * Parses HTML with parse5 (WHATWG-compliant tree construction) and lowers its tree into the
 * `@domflax/core` IR: every element → {@link IRElement} (tag + non-class attributes, with the `class`
 * attribute resolved through `ctx.resolver`/`ctx.normalizer` into `computed` so downstream patterns
 * match on resolved style), text → {@link IRText}, comments → {@link IRComment}. Doctype and
 * auto-inserted (`<html>`/`<head>`/`<body>`) wrappers are preserved verbatim: doctype is not
 * represented, synthetic wrappers become opaque (never edited).
 *
 * Precise SOURCE SPANS from parse5 location info (element span, open-/close-tag spans, and the `class`
 * VALUE span) are recorded in the {@link MutableBackrefTable} so the backend edits surgically instead
 * of re-serializing (which would reformat the whole document).
 *
 * OPACITY (never flatten/rewrite), enforced via `meta.safetyFloor = 0` (blocks every op above lint):
 *   • elements with an `id`, any inline `on*=` handler, or `contenteditable` (element only);
 *   • `<script>`/`<style>`/`<template>`/`<svg>`/`<pre>`/`<textarea>` subtrees (not descended into);
 *   • synthetic (auto-inserted) elements carrying no source location.
 *
 * parse5 is LAZILY required (via `createRequire`, since {@link Frontend.parse} is synchronous) INSIDE
 * `doParse`, so the JSX-only path never loads it.
 */

import { createRequire } from 'node:module';

import type {
  AttrMap,
  AttrValue,
  ClassList,
  ClassSegment,
  Diagnostic,
  FrontendParseContext,
  IRDocument,
  IRElement,
  IRFragment,
  IRNodeId,
  MutableBackrefTable,
  NodeMeta,
  ParseResult,
  SourceFile,
  StyleMap,
} from '@domflax/core';
import {
  createComment,
  createDocument,
  createElement,
  createText,
  defaultMeta,
  emptyClassList,
  emptyStyleMap,
} from '@domflax/core';

import type { P5Attr, P5Location, P5Node, Parse5Module } from './walk';
import {
  FILE_ID,
  attrsLocOf,
  classValueSpan,
  elementIsOpaque,
  hasEventHandler,
  isOpaqueSubtreeTag,
  span,
} from './walk';

/* ───────────────────────── lazy parse5 ───────────────────────── */

let cachedParse5: Parse5Module | null = null;

/**
 * Load parse5 lazily via `createRequire` (NOT a top-level import): {@link Frontend.parse} is
 * synchronous, so a dynamic `import()` is unavailable, and the JSX-only path must never pull parse5
 * into memory. Rooted at THIS module so it resolves the parse5 the frontend depends on.
 */
function loadParse5(): Parse5Module {
  if (cachedParse5) return cachedParse5;
  const req = createRequire(import.meta.url);
  cachedParse5 = req('parse5') as Parse5Module;
  return cachedParse5;
}

/* ───────────────────────── parse pass ───────────────────────── */

export function doParse(code: string, ctx: FrontendParseContext): ParseResult {
  const diagnostics: Diagnostic[] = [];
  const doc: IRDocument = createDocument('html');
  const backref = doc.backref as MutableBackrefTable;

  const parse5 = loadParse5();
  const document = parse5.parse(code, { sourceCodeLocationInfo: true });

  const eol: '\n' | '\r\n' = code.includes('\r\n') ? '\r\n' : '\n';
  const sourceFile: SourceFile = {
    id: FILE_ID,
    path: ctx.id,
    text: code,
    frontend: 'html',
    eol,
    indentUnit: '  ',
    native: document,
  };
  doc.sources.set(FILE_ID, sourceFile);

  /* ----- class resolution (static classes → computed style) ----- */

  const resolveComputed = (
    tokens: readonly string[],
    tag: string,
    nodeId: IRNodeId,
    meta: NodeMeta,
  ): StyleMap => {
    if (tokens.length === 0) return emptyStyleMap();
    const res = ctx.resolver.resolve({ classes: tokens, element: { tagName: tag, namespace: 'html' } });
    // SAFETY (Layer 2): any unresolved token → the element's true style is UNKNOWN → mark it opaque
    // for flatten (never unwrap it as inert). Resolved-to-no-paint elements keep hasUnresolvedClasses
    // false and stay flatten-eligible.
    if (res.unknown.length > 0) meta.hasUnresolvedClasses = true;
    for (const w of res.warnings) {
      diagnostics.push({
        code: 'DF_STYLE_CONFLICT_UNRESOLVED',
        severity: w.severity,
        message: w.message,
        nodeId,
      });
    }
    return ctx.normalizer.normalizeStyleMap(res.styles);
  };

  const splitTokens = (raw: string): string[] => raw.split(/\s+/).filter((t) => t.length > 0);

  /* ----- child lowering ----- */

  const appendChild = (node: P5Node, parentId: IRNodeId, out: IRNodeId[]): void => {
    const name = node.nodeName;
    if (name === '#text') {
      const value = node.value ?? '';
      const id = doc.alloc.next();
      const loc = node.sourceCodeLocation ?? null;
      doc.nodes.set(
        id,
        createText(id, value, {
          parent: parentId,
          span: loc ? span(loc.startOffset, loc.endOffset) : null,
          collapsible: /^\s*$/.test(value),
        }),
      );
      out.push(id);
      return;
    }
    if (name === '#comment') {
      const id = doc.alloc.next();
      const loc = node.sourceCodeLocation ?? null;
      doc.nodes.set(
        id,
        createComment(id, node.data ?? '', {
          parent: parentId,
          span: loc ? span(loc.startOffset, loc.endOffset) : null,
        }),
      );
      out.push(id);
      return;
    }
    if (name === '#documentType') return; // doctype stays verbatim in source (never represented)
    if (name.startsWith('#')) {
      // #document / #document-fragment — a container with no element identity: hoist its children.
      for (const c of node.childNodes ?? []) appendChild(c, parentId, out);
      return;
    }
    out.push(buildElement(node, parentId));
  };

  /* ----- element lowering ----- */

  const buildElement = (node: P5Node, parentId: IRNodeId): IRNodeId => {
    const id = doc.alloc.next();
    const tag = (node.tagName ?? node.nodeName).toLowerCase();
    const loc: P5Location | null = node.sourceCodeLocation ?? null;
    const attrsArr: readonly P5Attr[] = node.attrs ?? [];

    const opaqueSubtree = isOpaqueSubtreeTag(tag);
    const synthetic = loc == null; // auto-inserted <html>/<head>/<body>
    const opaque = opaqueSubtree || synthetic || elementIsOpaque(attrsArr);

    const meta: NodeMeta = defaultMeta();
    meta.hasEventHandlers = hasEventHandler(attrsArr);
    // Opaque nodes get floor 0 (any op above lint is refused by the applier); optimizable nodes get
    // floor 3 (fully open — the pattern predicates + flatten classifier are the real gate).
    meta.safetyFloor = opaque ? 0 : 3;

    // Split attributes: `class` → ClassList; everything else → AttrMap entries (so flatten's
    // `hasOwnAttrs` guard sees id/data-*/… and refuses to unwrap the element).
    let classes: ClassList = emptyClassList();
    let classTokens: string[] = [];
    const entries = new Map<string, AttrValue>();
    const order: string[] = [];

    for (const a of attrsArr) {
      if (a.name.toLowerCase() === 'class') {
        classTokens = splitTokens(a.value);
        const valueSpan = classValueSpan(loc, code);
        const clAttr = attrsLocOf(loc)?.['class'];
        const seg: ClassSegment = {
          kind: 'static',
          span: valueSpan ?? undefined,
          tokens: classTokens.map((value) => ({ value })),
        };
        classes = {
          form: 'string-literal',
          segments: [seg],
          valueSpan,
          attrSpan: clAttr ? span(clAttr.startOffset, clAttr.endOffset) : undefined,
          hasDynamic: false,
          opaque: false,
          rewritable: valueSpan != null,
        };
        continue;
      }
      const v = a.value;
      entries.set(a.name, { kind: 'static', value: v === '' ? true : v });
      order.push(a.name);
    }

    const attrs: AttrMap = { entries, spreads: [], order };
    const computed = resolveComputed(classTokens, tag, id, meta);

    // Children — opaque-subtree elements are NOT descended into; their inner bytes survive verbatim.
    const children: IRNodeId[] = [];
    if (!opaqueSubtree) {
      for (const c of node.childNodes ?? []) appendChild(c, id, children);
    }

    const el: IRElement = createElement(id, {
      tag,
      namespace: 'html',
      isComponent: false,
      selfClosing: loc ? loc.endTag == null : false,
      classes,
      computed,
      attrs,
      children,
      parent: parentId,
      span: loc ? span(loc.startOffset, loc.endOffset) : null,
      meta,
    });
    doc.nodes.set(id, el);

    // Backref (surgical-edit anchors) — only for elements with a real source location. Synthetic
    // wrappers get none, so the backend never tries to move/remove their bytes.
    if (loc) {
      backref.set(id, {
        nodeId: id,
        span: span(loc.startOffset, loc.endOffset),
        openTagSpan: loc.startTag ? span(loc.startTag.startOffset, loc.startTag.endOffset) : null,
        closeTagSpan: loc.endTag ? span(loc.endTag.startOffset, loc.endTag.endOffset) : null,
        innerSpan: null,
        selfClosing: loc.endTag == null,
      });
    }
    return id;
  };

  /* ----- attach top-level nodes under the root fragment ----- */

  const rootFrag = doc.nodes.get(doc.root) as IRFragment;
  appendChild(document, doc.root, rootFrag.children);

  return { doc, diagnostics };
}
