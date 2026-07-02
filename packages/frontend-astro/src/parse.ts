/**
 * @domflax/frontend-astro — the `.astro` → IR parse pass.
 *
 * REGION MODEL — `splitAstro` divides the file into FRONTMATTER (preserved verbatim, never parsed,
 * never represented in the IR — like the HTML frontend's doctype) and TEMPLATE, which is parsed with
 * parse5 in FRAGMENT mode. Every parse5 offset is template-relative, so `templateStart` is added to
 * every span recorded in the {@link MutableBackrefTable} for surgical codegen.
 *
 * WHOLE-FILE PASSTHROUGH — when the file contains ANY `<style>` block (Astro styles are SCOPED: the
 * compiler rewrites selectors against the exact element structure, so any edit can detach rules) or
 * the frontmatter fence is malformed, the template is NOT lowered at all: the document carries only
 * the retained source, and the backend reprints it byte-for-byte.
 *
 * OPACITY (never flatten/rewrite), enforced via `meta.safetyFloor = 0`:
 *   • components (capitalized/dotted names, recovered from SOURCE bytes — parse5 lowercases tags),
 *     any directive (`client:*`, `set:*`, `is:*`, `define:*`, `class:list`, any `:` name), spreads,
 *     `<slot>`, and the HTML opaque-subtree tags — none of these subtrees are descended into;
 *   • elements with an `id`, inline `on*=` handler, `contenteditable`, or ANY attribute value
 *     containing `{` (an Astro expression);
 *   • `{expr}` text marks the PARENT `hasDynamicChildren` (blocks flatten); an UNBALANCED brace text
 *     means an expression spans siblings, so every element sibling is forced opaque.
 *
 * SELF-CLOSING RECOVERY — parse5 ignores `/>` on non-void elements, so `<Card />` swallows the
 * following siblings as children. When the SOURCE open tag ends in `/>` and parse5 found no end tag,
 * the element is childless by construction: its parse5 "children" are hoisted back as siblings (and
 * its span shrinks to the open tag), so real elements after a component stay optimizable.
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

import { hasStyleBlock, splitAstro } from './regions';
import type { P5Attr, P5Location, P5Node, Parse5Module } from './walk';
import {
  FILE_ID,
  bracesBalanced,
  classValueSpan,
  containsBrace,
  elementIsOpaque,
  hasDirectiveAttr,
  hasDynamicAttrValue,
  hasEventHandler,
  hasSpreadAttr,
  isComponentOpenTag,
  isOpaqueSubtreeTag,
  isSelfClosingOpenTag,
  spanAt,
} from './walk';

/* ───────────────────────── lazy parse5 ───────────────────────── */

let cachedParse5: Parse5Module | null = null;

/** Load parse5 lazily via `createRequire` ({@link Frontend.parse} is synchronous). */
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

  const eol: '\n' | '\r\n' = code.includes('\r\n') ? '\r\n' : '\n';
  const sourceFile: SourceFile = {
    id: FILE_ID,
    path: ctx.id,
    text: code,
    frontend: 'html',
    eol,
    indentUnit: '  ',
    native: undefined,
  };
  doc.sources.set(FILE_ID, sourceFile);

  /* ----- whole-file passthrough gates (no template lowering AT ALL) ----- */

  const split = splitAstro(code);
  if (!split.ok) {
    diagnostics.push({
      code: 'DF_CROSSED_DYNAMIC_BOUNDARY',
      severity: 'info',
      message: `${ctx.id}: unterminated frontmatter fence — the whole component passes through unchanged.`,
    });
    return { doc, diagnostics };
  }
  if (hasStyleBlock(code)) {
    diagnostics.push({
      code: 'DF_CROSSED_DYNAMIC_BOUNDARY',
      severity: 'info',
      message: `${ctx.id}: contains a <style> block (Astro styles are scoped to the component's exact element structure) — the whole component passes through unchanged.`,
    });
    return { doc, diagnostics };
  }

  const base = split.templateStart;
  const template = code.slice(base);
  const parse5 = loadParse5();
  const fragment = parse5.parseFragment(template, { sourceCodeLocationInfo: true });
  sourceFile.native = fragment;

  /* ----- class resolution (static classes → computed style) ----- */

  const resolveComputed = (
    tokens: readonly string[],
    tag: string,
    nodeId: IRNodeId,
    meta: NodeMeta,
  ): StyleMap => {
    if (tokens.length === 0) return emptyStyleMap();
    const res = ctx.resolver.resolve({ classes: tokens, element: { tagName: tag, namespace: 'html' } });
    // SAFETY (Layer 2): any unresolved token → the element's true style is UNKNOWN → opaque for
    // flatten (never unwrapped as inert). Resolved-to-no-paint elements stay flatten-eligible.
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

  /**
   * Lower a batch of parse5 siblings into `out` under `parentId`. Scans the batch's DIRECT text
   * children first: any `{`/`}` marks the parent `hasDynamicChildren` (blocks flatten of the parent);
   * any UNBALANCED brace text forces every element in the batch opaque (an expression spans across
   * siblings, so none of them is provably real markup).
   */
  const lowerChildren = (
    nodes: readonly P5Node[],
    parentId: IRNodeId,
    out: IRNodeId[],
    parentMeta: NodeMeta,
    forceOpaque: boolean,
  ): void => {
    let sawBrace = false;
    let unbalanced = false;
    for (const n of nodes) {
      if (n.nodeName === '#text' && containsBrace(n.value ?? '')) {
        sawBrace = true;
        if (!bracesBalanced(n.value ?? '')) unbalanced = true;
      }
    }
    if (sawBrace) parentMeta.hasDynamicChildren = true;
    const childForce = forceOpaque || unbalanced;
    for (const n of nodes) appendChild(n, parentId, out, parentMeta, childForce);
  };

  const appendChild = (
    node: P5Node,
    parentId: IRNodeId,
    out: IRNodeId[],
    parentMeta: NodeMeta,
    forceOpaque: boolean,
  ): void => {
    const name = node.nodeName;
    if (name === '#text') {
      const value = node.value ?? '';
      const id = doc.alloc.next();
      const loc = node.sourceCodeLocation ?? null;
      doc.nodes.set(
        id,
        createText(id, value, {
          parent: parentId,
          span: loc ? spanAt(base, loc) : null,
          // `{expr}` text is opaque dynamic content — never collapsed or merged.
          collapsible: !containsBrace(value) && /^\s*$/.test(value),
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
          span: loc ? spanAt(base, loc) : null,
        }),
      );
      out.push(id);
      return;
    }
    if (name === '#documentType') return; // doctype stays verbatim in source (never represented)
    if (name.startsWith('#')) {
      // #document-fragment — a container with no element identity: hoist its children.
      lowerChildren(node.childNodes ?? [], parentId, out, parentMeta, forceOpaque);
      return;
    }
    buildElement(node, parentId, out, parentMeta, forceOpaque);
  };

  /* ----- element lowering ----- */

  const buildElement = (
    node: P5Node,
    parentId: IRNodeId,
    out: IRNodeId[],
    parentMeta: NodeMeta,
    forceOpaque: boolean,
  ): void => {
    const id = doc.alloc.next();
    const tag = (node.tagName ?? node.nodeName).toLowerCase();
    const loc: P5Location | null = node.sourceCodeLocation ?? null;
    const startTag = loc?.startTag ?? null;
    const attrsArr: readonly P5Attr[] = node.attrs ?? [];
    const openTagText = startTag ? template.slice(startTag.startOffset, startTag.endOffset) : '';

    const component = isComponentOpenTag(openTagText);
    const spread = hasSpreadAttr(attrsArr);
    const opaqueSubtree =
      forceOpaque || component || spread || hasDirectiveAttr(attrsArr) || isOpaqueSubtreeTag(tag);
    const synthetic = loc == null;
    const opaque =
      opaqueSubtree || synthetic || hasDynamicAttrValue(attrsArr) || elementIsOpaque(attrsArr);

    // A component or <slot> renders content this file cannot see — the PARENT's children are
    // effectively dynamic, so a wrapper around one is never flattened.
    if (component || tag === 'slot') parentMeta.hasDynamicChildren = true;

    const meta: NodeMeta = defaultMeta();
    meta.isComponent = component;
    meta.hasSpreadAttrs = spread;
    meta.hasEventHandlers = hasEventHandler(attrsArr);
    meta.safetyFloor = opaque ? 0 : 3;

    // Split attributes: static `class` → ClassList (dynamic `class={…}` → opaque list); everything
    // else → AttrMap entries (so flatten's hasOwnAttrs guard sees id/data-*/… and refuses to unwrap).
    let classes: ClassList = emptyClassList();
    let classTokens: string[] = [];
    const entries = new Map<string, AttrValue>();
    const order: string[] = [];

    for (const a of attrsArr) {
      if (a.name.toLowerCase() === 'class') {
        if (a.value.includes('{')) {
          // `class={expr}` / mixed — a dynamic expression this frontend never rewrites.
          classes = {
            form: 'member',
            segments: [],
            valueSpan: null,
            hasDynamic: true,
            opaque: true,
            rewritable: false,
          };
          continue;
        }
        classTokens = splitTokens(a.value);
        const valueSpan = classValueSpan(loc, template, base);
        const clAttr = (loc?.startTag?.attrs ?? loc?.attrs)?.['class'];
        const seg: ClassSegment = {
          kind: 'static',
          span: valueSpan ?? undefined,
          tokens: classTokens.map((value) => ({ value })),
        };
        classes = {
          form: 'string-literal',
          segments: [seg],
          valueSpan,
          attrSpan: clAttr ? spanAt(base, clAttr) : undefined,
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

    // Children — opaque subtrees are NOT descended into (their inner bytes survive verbatim). The
    // one recovery: a SOURCE-self-closed non-void element (`<Card />`) is childless in Astro, so the
    // siblings parse5 mis-nested under it are hoisted back out to the parent.
    const children: IRNodeId[] = [];
    let hoisted: readonly P5Node[] | null = null;
    const misNested =
      startTag != null &&
      loc?.endTag == null &&
      isSelfClosingOpenTag(openTagText) &&
      (node.childNodes?.length ?? 0) > 0;
    if (opaqueSubtree) {
      if (misNested) hoisted = node.childNodes ?? null;
    } else if (misNested) {
      hoisted = node.childNodes ?? null;
    } else {
      lowerChildren(node.childNodes ?? [], id, children, meta, forceOpaque);
    }

    // For a recovered self-closed element the true span is its open tag (parse5's whole-node span
    // wrongly extends over the mis-nested siblings).
    const elemSpan = hoisted && startTag ? spanAt(base, startTag) : loc ? spanAt(base, loc) : null;

    const el: IRElement = createElement(id, {
      tag,
      namespace: 'html',
      isComponent: component,
      selfClosing: loc ? loc.endTag == null : false,
      classes,
      computed,
      attrs,
      children,
      parent: parentId,
      span: elemSpan,
      meta,
    });
    doc.nodes.set(id, el);

    // Backref (surgical-edit anchors) — only for elements with a real source location.
    if (loc && elemSpan) {
      backref.set(id, {
        nodeId: id,
        span: elemSpan,
        openTagSpan: startTag ? spanAt(base, startTag) : null,
        closeTagSpan: loc.endTag ? spanAt(base, loc.endTag) : null,
        innerSpan: null,
        selfClosing: loc.endTag == null,
      });
    }
    out.push(id);

    // Hoisted mis-nested "children" are really the element's FOLLOWING SIBLINGS: lower them into the
    // same parent, with the same force flag (they were never inside the opaque element).
    if (hoisted) lowerChildren(hoisted, parentId, out, parentMeta, forceOpaque);
  };

  /* ----- attach top-level template nodes under the root fragment ----- */

  const rootFrag = doc.nodes.get(doc.root) as IRFragment;
  lowerChildren(fragment.childNodes ?? [], doc.root, rootFrag.children, rootFrag.meta, false);

  return { doc, diagnostics };
}
