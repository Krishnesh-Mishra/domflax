/**
 * @domflax/frontend-vue — the `.vue` SFC → IR parse pass (TEMPLATE BLOCK ONLY).
 *
 * Parses the SFC with `@vue/compiler-sfc` (loaded lazily; optional peer) and lowers ONLY the
 * `<template>` block's AST into the `@domflax/core` IR — `<script>`/`<style>` blocks and every byte
 * outside the template are NEVER represented, so the backend can never edit them. compiler-core node
 * `loc` offsets are ABSOLUTE into the whole `.vue` file (verified per element at lower time), so the
 * recorded {@link SourceSpan}s splice the real file surgically.
 *
 * WHOLE-FILE PASSTHROUGH (byte-identical, zero IR) whenever ANY of these hold — uncertain ⇒ preserved:
 *   • `@vue/compiler-sfc` unavailable, SFC parse errors, or a span sanity-check mismatch;
 *   • ANY `<style>` block — scoped/module styles couple selectors to the exact DOM shape, and even a
 *     plain `<style>` may target template structure this frontend does not model (conservative);
 *   • no `<template>`, an external `src` template, a non-HTML template `lang` (pug, …), or no AST.
 *
 * OPACITY inside the template (see `./opacity`): any directive / `v-*`-`:`-`@`-`#` syntax, component
 * tags, `<slot>`, nested `<template>`, svg/mathml, raw-text tags — SUBTREE-opaque (never descended
 * into); `id` / `on*=` / `contenteditable` / static `ref` / `key` — element-opaque (floor 0, children
 * still lowered); `{{ interpolation }}` children lower to IRExpr and raise the parent's
 * `hasDynamicChildren`, which blocks every flatten of the parent (class compress stays possible).
 *
 * Plain static elements with a static `class="…"` resolve through `ctx.resolver`/`ctx.normalizer`
 * onto `computed` exactly like the HTML frontend — inert wrappers flattenable, classes compressible.
 */

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
  createExpr,
  createText,
  defaultMeta,
  emptyClassList,
  emptyStyleMap,
} from '@domflax/core';

import {
  classValueSpan,
  closeTagSpan,
  elementIsOpaque,
  hasEventHandler,
  isOpaqueSubtree,
  openTagSpan,
  staticAttrsOf,
} from './opacity';
import type { SfcTemplateBlock, TplChildNode, TplElementNode } from './sfc';
import { FILE_ID, loadCompilerSfc, span, TPL, TPL_TAG } from './sfc';

/** Internal sentinel: a compiler loc failed the source sanity check ⇒ abort to passthrough. */
class SpanMismatchError extends Error {}

/* ───────────────────────── document scaffolding ───────────────────────── */

function newDocWithSource(code: string, ctx: FrontendParseContext): IRDocument {
  const doc = createDocument('html'); // core has no 'vue' FrontendKind; the template dialect is HTML
  const eol: '\n' | '\r\n' = code.includes('\r\n') ? '\r\n' : '\n';
  const sourceFile: SourceFile = {
    id: FILE_ID,
    path: ctx.id,
    text: code,
    frontend: 'html',
    eol,
    indentUnit: '  ',
  };
  doc.sources.set(FILE_ID, sourceFile);
  return doc;
}

/**
 * A passthrough result: the source is retained but NOTHING is represented as optimizable IR, so the
 * surgical backend reproduces the file byte-for-byte.
 */
function passthrough(code: string, ctx: FrontendParseContext, why?: string): ParseResult {
  const doc = newDocWithSource(code, ctx);
  const diagnostics: Diagnostic[] = why
    ? [{ code: 'DF_CROSSED_DYNAMIC_BOUNDARY', severity: 'debug', message: `vue frontend passthrough: ${why}` }]
    : [];
  return { doc, diagnostics };
}

/** Should this SFC bypass optimization entirely? Returns the reason, or null to proceed. */
function passthroughReason(
  errors: readonly unknown[],
  template: SfcTemplateBlock | null,
  styleCount: number,
): string | null {
  if (errors.length > 0) return 'SFC parse errors';
  if (styleCount > 0) return '<style> block present (scoped/module/plain — conservative)';
  if (!template) return 'no <template> block';
  if (template.src != null) return 'external template src';
  if (template.lang && template.lang.toLowerCase() !== 'html') return `template lang="${template.lang}"`;
  if (!template.ast || !Array.isArray(template.ast.children)) return 'no template AST';
  return null;
}

/* ───────────────────────── parse pass ───────────────────────── */

export function doParse(code: string, ctx: FrontendParseContext): ParseResult {
  const sfc = loadCompilerSfc();
  if (!sfc) return passthrough(code, ctx, '@vue/compiler-sfc unavailable');

  let parsed: ReturnType<typeof sfc.parse>;
  try {
    parsed = sfc.parse(code, {
      filename: ctx.id,
      sourceMap: false,
      // Keep the AST maximally faithful to the source: comments retained, whitespace un-condensed.
      templateParseOptions: { comments: true, whitespace: 'preserve' },
    });
  } catch {
    return passthrough(code, ctx, '@vue/compiler-sfc parse threw');
  }

  const { descriptor, errors } = parsed;
  const reason = passthroughReason(errors, descriptor.template, descriptor.styles.length);
  if (reason) return passthrough(code, ctx, reason);
  const template = descriptor.template!;

  try {
    return lowerTemplate(code, ctx, template);
  } catch (e) {
    if (e instanceof SpanMismatchError) return passthrough(code, ctx, 'span sanity check failed');
    throw e;
  }
}

/* ───────────────────────── template lowering ───────────────────────── */

function lowerTemplate(
  code: string,
  ctx: FrontendParseContext,
  template: SfcTemplateBlock,
): ParseResult {
  const diagnostics: Diagnostic[] = [];
  const doc = newDocWithSource(code, ctx);
  const backref = doc.backref as MutableBackrefTable;

  /** compiler locs must map 1:1 onto the real file, or the whole parse aborts to passthrough. */
  const checkedSpan = (start: number, end: number, source: string) => {
    if (start < 0 || end > code.length || code.slice(start, end) !== source) {
      throw new SpanMismatchError();
    }
    return span(start, end);
  };

  /* ----- class resolution (static classes → computed style; mirrors the HTML frontend) ----- */

  const resolveComputed = (
    tokens: readonly string[],
    tag: string,
    nodeId: IRNodeId,
    meta: NodeMeta,
  ): StyleMap => {
    if (tokens.length === 0) return emptyStyleMap();
    const res = ctx.resolver.resolve({ classes: tokens, element: { tagName: tag, namespace: 'html' } });
    // SAFETY (Layer 2): any unresolved token ⇒ the element's true style is UNKNOWN ⇒ opaque for
    // flatten (never unwrapped as inert). Resolved-to-no-paint elements stay flatten-eligible.
    // STRICTER than a bare `unknown` check: a token the resolver did not account for AT ALL (neither
    // resolved, unknown, nor opaque — e.g. a null/degenerate resolver) is treated as unresolved too.
    if (res.unknown.length > 0) meta.hasUnresolvedClasses = true;
    else {
      const accounted = new Set<string>([...res.resolved, ...res.opaque.map((o) => o.token)]);
      if (tokens.some((t) => !accounted.has(t))) meta.hasUnresolvedClasses = true;
    }
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

  const appendChild = (node: TplChildNode, parentId: IRNodeId, out: IRNodeId[], parentMeta: NodeMeta): void => {
    if (node.type === TPL.TEXT) {
      const t = node as { content: string; loc: { start: { offset: number }; end: { offset: number }; source: string } };
      const id = doc.alloc.next();
      doc.nodes.set(
        id,
        createText(id, t.content, {
          parent: parentId,
          span: checkedSpan(t.loc.start.offset, t.loc.end.offset, t.loc.source),
          collapsible: /^\s*$/.test(t.content),
        }),
      );
      out.push(id);
      return;
    }
    if (node.type === TPL.COMMENT) {
      const c = node as { content: string; loc: { start: { offset: number }; end: { offset: number }; source: string } };
      const id = doc.alloc.next();
      doc.nodes.set(
        id,
        createComment(id, c.content, {
          parent: parentId,
          span: checkedSpan(c.loc.start.offset, c.loc.end.offset, c.loc.source),
        }),
      );
      out.push(id);
      return;
    }
    if (node.type === TPL.ELEMENT) {
      out.push(buildElement(node as TplElementNode, parentId));
      return;
    }
    // INTERPOLATION — and, conservatively, ANY node type this frontend does not model: a dynamic
    // island. It blocks every flatten of the parent (hasDynamicChildren) and its bytes are preserved.
    parentMeta.hasDynamicChildren = true;
    const loc = (node as { loc?: { start: { offset: number }; end: { offset: number }; source: string } }).loc;
    if (!loc) return; // un-locatable ⇒ not represented; parent already marked dynamic
    const s = checkedSpan(loc.start.offset, loc.end.offset, loc.source);
    const ref = doc.exprs.intern({ span: s, kind: 'other' });
    const id = doc.alloc.next();
    doc.nodes.set(id, createExpr(id, ref, { parent: parentId, span: s }));
    out.push(id);
  };

  /* ----- element lowering ----- */

  const buildElement = (node: TplElementNode, parentId: IRNodeId): IRNodeId => {
    const id = doc.alloc.next();
    const tag = node.tag.toLowerCase();
    const start = node.loc.start.offset;
    const end = node.loc.end.offset;
    const elSpan = checkedSpan(start, end, node.loc.source);

    const opaqueSubtree = isOpaqueSubtree(node);
    const attrs = staticAttrsOf(node);
    const opaque = opaqueSubtree || elementIsOpaque(attrs);

    const meta: NodeMeta = defaultMeta();
    meta.isComponent = node.tagType === TPL_TAG.COMPONENT;
    meta.hasEventHandlers = hasEventHandler(node.props);
    meta.hasRef = attrs.some((a) => a.name === 'ref');
    meta.hasKey = attrs.some((a) => a.name === 'key');
    // Opaque nodes get floor 0 (any op above lint is refused by the applier); optimizable nodes get
    // floor 3 (fully open — the pattern predicates + flatten classifier are the real gate).
    meta.safetyFloor = opaque ? 0 : 3;

    // Split static attributes: `class` → ClassList; everything else → AttrMap entries (so flatten's
    // `hasOwnAttrs` guard sees id/data-*/… and refuses to unwrap the element). Directive props are
    // NOT represented — any directive already made the whole subtree opaque above.
    let classes: ClassList = emptyClassList();
    let classTokens: string[] = [];
    const entries = new Map<string, AttrValue>();
    const order: string[] = [];

    for (const a of attrs) {
      if (a.name.toLowerCase() === 'class' && !opaqueSubtree) {
        classTokens = splitTokens(a.value?.content ?? '');
        const valueSpan = a.value
          ? checkedSpan(a.value.loc.start.offset, a.value.loc.end.offset, a.value.loc.source)
          : classValueSpan(a);
        const seg: ClassSegment = {
          kind: 'static',
          span: valueSpan ?? undefined,
          tokens: classTokens.map((value) => ({ value })),
        };
        classes = {
          form: 'string-literal',
          segments: [seg],
          valueSpan,
          attrSpan: span(a.loc.start.offset, a.loc.end.offset),
          hasDynamic: false,
          opaque: false,
          rewritable: valueSpan != null,
        };
        continue;
      }
      const v = a.value?.content;
      entries.set(a.name, { kind: 'static', value: v == null || v === '' ? true : v });
      order.push(a.name);
    }

    const attrMap: AttrMap = { entries, spreads: [], order };
    const computed = opaqueSubtree
      ? emptyStyleMap()
      : resolveComputed(classTokens, tag, id, meta);

    // Children — opaque subtrees are NOT descended into; their inner bytes survive verbatim.
    const children: IRNodeId[] = [];
    if (!opaqueSubtree) {
      for (const c of node.children) appendChild(c, id, children, meta);
    }

    const open = openTagSpan(code, start, end);
    const close = node.isSelfClosing ? null : closeTagSpan(code, start, end, node.tag);

    const el: IRElement = createElement(id, {
      tag,
      namespace: 'html',
      isComponent: meta.isComponent,
      selfClosing: close == null,
      classes,
      computed,
      attrs: attrMap,
      children,
      parent: parentId,
      span: elSpan,
      meta,
    });
    doc.nodes.set(id, el);

    // Backref (surgical-edit anchors). Only registered when the open tag could be derived — without
    // it the backend must never attempt a structural edit on this element.
    if (open) {
      backref.set(id, {
        nodeId: id,
        span: elSpan,
        openTagSpan: open,
        closeTagSpan: close,
        innerSpan: open && close ? span(open.end, close.start) : null,
        selfClosing: close == null,
      });
    }
    return id;
  };

  /* ----- attach template children under the root fragment ----- */

  const rootFrag = doc.nodes.get(doc.root) as IRFragment;
  for (const child of template.ast!.children) {
    appendChild(child, doc.root, rootFrag.children, rootFrag.meta);
  }

  return { doc, diagnostics };
}
