/**
 * @domflax/frontend-jsx — the JSX/TSX → IR parse pass.
 *
 * Walks a Babel AST (`@babel/parser` → `@babel/traverse`) and lowers JSXElement /
 * JSXFragment / JSXText / JSXExpressionContainer / JSXSpreadChild nodes into the
 * `@domflax/core` IR. ALL dynamic JavaScript stays out of the structural IR: every
 * expression container, spread, and dynamic className/child is interned into the
 * document's {@link ExprRegistry} as an opaque {@link ExprRef} (with its verbatim source
 * slice as payload), and only its source span survives in the tree.
 *
 * Static `class`/`className` literals are split into {@link ClassToken}s on a static
 * {@link ClassSegment}; recognized `cn()`/`clsx()`/template-literal expressions are split into
 * mixed static/dynamic segments (STATIC EXTRACTION — see `./frontend-classlist`); any other
 * dynamic className becomes a single opaque dynamic segment. Static class tokens (including the
 * static segments of a mixed list) are resolved through the supplied {@link StyleResolver} +
 * {@link StyleNormalizer} into `element.computed` so downstream patterns can match on resolved
 * style — for a mixed list that computed is PARTIAL, and the element stays opaque for flatten.
 *
 * NodeMeta opacity barriers populated here: hasRef (`ref=`), hasEventHandlers (`on*=`),
 * hasKey (`key=`), hasSpreadAttrs (`{...x}`), hasDangerousHtml
 * (`dangerouslySetInnerHTML=`), hasDynamicChildren (any expression / spread child),
 * isComponent (capitalized / member tag). "hasDynamicClasses" is carried on the
 * {@link ClassList} itself (`hasDynamic` / `opaque`), not on NodeMeta.
 */

import { parse as babelParse } from '@babel/parser';
import type { NodePath } from '@babel/traverse';
import type {
  Expression,
  JSXAttribute,
  JSXElement,
  JSXFragment,
  JSXOpeningElement,
  Node as BabelNode,
} from '@babel/types';

import type {
  AttrMap,
  AttrValue,
  ClassList,
  Diagnostic,
  ExprRef,
  FrontendParseContext,
  IRDocument,
  IRElement,
  IRFragment,
  IRNamespace,
  IRNodeId,
  MutableBackrefTable,
  NodeMeta,
  ParseResult,
  SourceFile,
  SourceSpan,
  StyleMap,
} from '@domflax/core';
import {
  createDocument,
  createElement,
  createExpr,
  createFragment,
  createText,
  defaultMeta,
  emptyClassList,
  emptyStyleMap,
} from '@domflax/core';

import type { ExprPayload } from './frontend-ast';
import {
  FILE_ID,
  attrName,
  exprKind,
  findNestedJsxRoots,
  isComponentName,
  jsxName,
  traverse,
} from './frontend-ast';
import type { ClassListHelpers } from './frontend-classlist';
import { DEFAULT_CLASS_CALLEES, buildClassList } from './frontend-classlist';

export function doParse(code: string, ctx: FrontendParseContext): ParseResult {
  const diagnostics: Diagnostic[] = [];
  const doc: IRDocument = createDocument('jsx');
  const backref = doc.backref as MutableBackrefTable;

  const ast = babelParse(code, {
    sourceType: 'module',
    plugins: ['jsx', 'typescript'],
  });

  const eol: '\n' | '\r\n' = code.includes('\r\n') ? '\r\n' : '\n';
  const sourceFile: SourceFile = {
    id: FILE_ID,
    path: ctx.id,
    text: code,
    frontend: 'jsx',
    eol,
    indentUnit: '  ',
    native: ast,
  };
  doc.sources.set(FILE_ID, sourceFile);

  /* ----- span helpers (close over `code`) ----- */

  const spanOf = (node: BabelNode): SourceSpan | null => {
    if (node.start == null || node.end == null) return null;
    const span: SourceSpan = {
      file: FILE_ID,
      start: node.start,
      end: node.end,
      startLoc: node.loc
        ? { line: node.loc.start.line, column: node.loc.start.column }
        : undefined,
      endLoc: node.loc ? { line: node.loc.end.line, column: node.loc.end.column } : undefined,
    };
    return span;
  };

  const sliceOf = (node: BabelNode): string =>
    node.start == null || node.end == null ? '' : code.slice(node.start, node.end);

  /** Intern any node as an opaque ExprRef, recording its verbatim source slice. */
  const internExpr = (node: BabelNode, spread: boolean): ExprRef => {
    const payload: ExprPayload = { text: sliceOf(node), spread };
    return doc.exprs.intern({
      span: spanOf(node) ?? { file: FILE_ID, start: 0, end: 0 },
      kind: exprKind(node),
      payload,
    });
  };

  /* ----- class list (lowering lives in ./frontend-classlist) ----- */

  const configCallees = ctx.config['classCallees'];
  const classListHelpers: ClassListHelpers = {
    spanOf,
    slice: (start, end) => code.slice(start, end),
    internNode: internExpr,
    callees: new Set(
      Array.isArray(configCallees) && configCallees.every((c) => typeof c === 'string')
        ? (configCallees as string[])
        : DEFAULT_CLASS_CALLEES,
    ),
  };

  const staticTokensOf = (classes: ClassList): string[] => {
    const out: string[] = [];
    for (const seg of classes.segments) {
      if (seg.kind === 'static') for (const t of seg.tokens) out.push(t.value);
    }
    return out;
  };

  /* ----- attribute value ----- */

  const buildAttrValue = (attr: JSXAttribute): AttrValue => {
    const v = attr.value;
    if (v == null) return { kind: 'static', value: true, span: spanOf(attr) ?? undefined };
    if (v.type === 'StringLiteral') {
      return { kind: 'static', value: v.value, span: spanOf(v) ?? undefined };
    }
    if (v.type === 'JSXExpressionContainer') {
      if (v.expression.type === 'JSXEmptyExpression') {
        return { kind: 'static', value: true, span: spanOf(v) ?? undefined };
      }
      return { kind: 'dynamic', expr: internExpr(v.expression, false), span: spanOf(v) ?? undefined };
    }
    // JSXElement / JSXFragment used as an attribute value → opaque expression.
    return { kind: 'dynamic', expr: internExpr(v as Expression, false), span: spanOf(v) ?? undefined };
  };

  /* ----- node builders ----- */

  const buildNestedRoot = (jsx: JSXElement | JSXFragment, parentId: IRNodeId): IRNodeId =>
    jsx.type === 'JSXFragment' ? buildFragment(jsx, parentId) : buildElement(jsx, parentId);

  /** Lower a single JSX child, appending the resulting IR node id(s) onto `out`. */
  const appendChild = (
    node: JSXElement['children'][number],
    parentId: IRNodeId,
    out: IRNodeId[],
  ): void => {
    switch (node.type) {
      case 'JSXText': {
        const id = doc.alloc.next();
        doc.nodes.set(
          id,
          createText(id, node.value, {
            parent: parentId,
            span: spanOf(node),
            collapsible: /^\s*$/.test(node.value),
          }),
        );
        out.push(id);
        return;
      }
      case 'JSXExpressionContainer': {
        const expr = node.expression;
        if (expr.type === 'JSXEmptyExpression') return; // `{/* comment */}`
        // A container whose WHOLE expression is a JSX node (`{<X/>}`) renders that node directly —
        // lower it as a real element so passes can optimize it (no opaque wrapper needed).
        if (expr.type === 'JSXElement' || expr.type === 'JSXFragment') {
          out.push(buildNestedRoot(expr, parentId));
          return;
        }
        // Otherwise the expression itself stays OPAQUE — the `.map`/condition/`{expr}` hole is
        // interned and preserved verbatim by the backend …
        const id = doc.alloc.next();
        const ref = internExpr(expr, false);
        doc.nodes.set(id, createExpr(id, ref, { parent: parentId, span: spanOf(node) }));
        out.push(id);
        // … but any JSX nested INSIDE it (map/filter callbacks, `&&`/`||`, ternary, parens) is
        // lowered to real element nodes (with their true source spans) so the pass manager descends
        // into and optimizes them too.
        for (const jsx of findNestedJsxRoots(expr)) out.push(buildNestedRoot(jsx, parentId));
        return;
      }
      case 'JSXSpreadChild': {
        const id = doc.alloc.next();
        const ref = internExpr(node.expression, true);
        doc.nodes.set(id, createExpr(id, ref, { parent: parentId, span: spanOf(node) }));
        out.push(id);
        for (const jsx of findNestedJsxRoots(node.expression)) {
          out.push(buildNestedRoot(jsx, parentId));
        }
        return;
      }
      case 'JSXElement':
        out.push(buildElement(node, parentId));
        return;
      case 'JSXFragment':
        out.push(buildFragment(node, parentId));
        return;
      default:
        return;
    }
  };

  const buildFragment = (node: JSXFragment, parentId: IRNodeId): IRNodeId => {
    const id = doc.alloc.next();
    const children: IRNodeId[] = [];
    for (const c of node.children) appendChild(c, id, children);
    doc.nodes.set(id, createFragment(id, { children, parent: parentId, span: spanOf(node) }));
    backref.set(id, {
      nodeId: id,
      span: spanOf(node) ?? { file: FILE_ID, start: 0, end: 0 },
      openTagSpan: spanOf(node.openingFragment),
      closeTagSpan: spanOf(node.closingFragment),
      innerSpan: null,
      selfClosing: false,
    });
    return id;
  };

  const buildElement = (node: JSXElement, parentId: IRNodeId): IRNodeId => {
    const id = doc.alloc.next();
    const opening: JSXOpeningElement = node.openingElement;
    const tag = jsxName(opening.name);
    const component = isComponentName(opening.name);

    const meta: NodeMeta = defaultMeta();
    meta.isComponent = component;

    let classes: ClassList = emptyClassList();
    const entries = new Map<string, AttrValue>();
    const order: string[] = [];
    const spreads: ExprRef[] = [];

    for (const attr of opening.attributes) {
      if (attr.type === 'JSXSpreadAttribute') {
        spreads.push(internExpr(attr.argument, true));
        meta.hasSpreadAttrs = true;
        continue;
      }
      const name = attrName(attr.name);
      if (name === 'className' || name === 'class') {
        classes = buildClassList(attr, classListHelpers);
        continue;
      }
      if (name === 'ref') meta.hasRef = true;
      else if (name === 'key') meta.hasKey = true;
      else if (name === 'dangerouslySetInnerHTML') meta.hasDangerousHtml = true;
      else if (/^on[A-Z]/.test(name)) meta.hasEventHandlers = true;
      entries.set(name, buildAttrValue(attr));
      order.push(name);
    }

    const attrs: AttrMap = { entries, spreads, order };

    const children: IRNodeId[] = [];
    for (const c of node.children) appendChild(c, id, children);
    for (const cid of children) {
      const cn = doc.nodes.get(cid);
      if (cn && cn.kind === 'expr') {
        meta.hasDynamicChildren = true;
        break;
      }
    }

    // Resolve static classes (+ tag) into computed style via the injected resolver/normalizer.
    // For a MIXED (cn()/template) list only the STATIC segments' tokens resolve here, so computed is
    // PARTIAL — safe because `classes.hasDynamic` keeps the element opaque for flatten, and the
    // segment-local compress re-resolves each segment's own tokens independently. Partial computed
    // only ever ADDS style facts, which is strictly more conservative for the flatten guards.
    let computed: StyleMap = emptyStyleMap();
    {
      const tokens = staticTokensOf(classes);
      if (tokens.length > 0) {
        const res = ctx.resolver.resolve({
          classes: tokens,
          element: { tagName: tag, namespace: component ? undefined : 'html' },
        });
        computed = ctx.normalizer.normalizeStyleMap(res.styles);
        // SAFETY (Layer 2): a token the resolver could not resolve leaves the element's true style
        // UNKNOWN → mark it opaque for flatten (never unwrap it as inert). Distinct from a token that
        // resolved to no paint (which keeps the element flatten-eligible).
        if (res.unknown.length > 0) meta.hasUnresolvedClasses = true;
        for (const w of res.warnings) {
          diagnostics.push({
            code: 'DF_STYLE_CONFLICT_UNRESOLVED',
            severity: w.severity,
            message: w.message,
            nodeId: id,
          });
        }
      }
    }

    const namespace: IRNamespace = component ? 'component' : 'html';
    const el: IRElement = createElement(id, {
      tag,
      namespace,
      isComponent: component,
      selfClosing: opening.selfClosing,
      classes,
      computed,
      attrs,
      children,
      parent: parentId,
      span: spanOf(node),
      meta,
    });
    doc.nodes.set(id, el);

    const inner =
      children.length > 0
        ? spanOf(node.children[0]! as BabelNode) && spanOf(node.children.at(-1)! as BabelNode)
          ? {
              file: FILE_ID,
              start: spanOf(node.children[0]! as BabelNode)!.start,
              end: spanOf(node.children.at(-1)! as BabelNode)!.end,
            }
          : null
        : null;
    backref.set(id, {
      nodeId: id,
      span: spanOf(node) ?? { file: FILE_ID, start: 0, end: 0 },
      openTagSpan: spanOf(opening),
      closeTagSpan: node.closingElement ? spanOf(node.closingElement) : null,
      innerSpan: inner,
      selfClosing: opening.selfClosing,
    });
    return id;
  };

  /* ----- collect the outermost JSX islands and attach them to the root fragment ----- */

  const roots: (JSXElement | JSXFragment)[] = [];
  traverse(ast, {
    JSXElement(path: NodePath<JSXElement>) {
      roots.push(path.node);
      path.skip();
    },
    JSXFragment(path: NodePath<JSXFragment>) {
      roots.push(path.node);
      path.skip();
    },
  });

  const rootFrag = doc.nodes.get(doc.root) as IRFragment;
  for (const r of roots) {
    const id = r.type === 'JSXFragment' ? buildFragment(r, doc.root) : buildElement(r, doc.root);
    rootFrag.children.push(id);
  }

  return { doc, diagnostics };
}
