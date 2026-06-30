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
 */

import { parse as babelParse } from '@babel/parser';
import babelTraverse from '@babel/traverse';
import type { NodePath } from '@babel/traverse';
import type {
  Expression,
  JSXAttribute,
  JSXElement,
  JSXEmptyExpression,
  JSXFragment,
  JSXIdentifier,
  JSXMemberExpression,
  JSXNamespacedName,
  JSXOpeningElement,
  Node as BabelNode,
} from '@babel/types';

import type {
  AttrMap,
  AttrValue,
  ClassList,
  ClassListForm,
  ClassSegment,
  ClassToken,
  Diagnostic,
  ExprKind,
  ExprRef,
  FileKind,
  Frontend,
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
  SourceFileId,
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

/* ───────────────────────── @babel/traverse interop ───────────────────────── */

// `@babel/traverse` is published as CJS (`module.exports = traverse; exports.default = traverse`).
// Under an ESM default import the value may be the function OR `{ default: fn }` depending on the
// interop layer (Node ESM vs. esbuild vs. tsup), so normalize defensively.
const traverse = (
  typeof babelTraverse === 'function'
    ? babelTraverse
    : (babelTraverse as unknown as { default: typeof babelTraverse }).default
) as typeof babelTraverse;

/** Languages this frontend claims. JSX/TSX only; HTML is owned by a sibling frontend. */
const JSX_LANGS: readonly FileKind[] = ['jsx', 'tsx'];

/** The single registered source file id (one parse == one module). */
const FILE_ID = 1 as SourceFileId;

/** Marker payload stored for every interned expression so the backend can re-print it. */
interface ExprPayload {
  readonly text: string;
  readonly spread: boolean;
}

/* ───────────────────────── name + classification helpers ───────────────────────── */

type JSXName = JSXIdentifier | JSXMemberExpression | JSXNamespacedName;

function jsxName(node: JSXName): string {
  switch (node.type) {
    case 'JSXIdentifier':
      return node.name;
    case 'JSXMemberExpression':
      return `${jsxName(node.object)}.${node.property.name}`;
    case 'JSXNamespacedName':
      return `${node.namespace.name}:${node.name.name}`;
  }
}

/** Component vs. intrinsic: capitalized identifier or member expression ⇒ component. */
function isComponentName(node: JSXName): boolean {
  if (node.type === 'JSXMemberExpression') return true;
  if (node.type === 'JSXNamespacedName') return false;
  return /^[A-Z]/.test(node.name);
}

function attrName(name: JSXAttribute['name']): string {
  return name.type === 'JSXNamespacedName'
    ? `${name.namespace.name}:${name.name.name}`
    : name.name;
}

function exprKind(node: BabelNode): ExprKind {
  switch (node.type) {
    case 'CallExpression':
    case 'OptionalCallExpression':
      return 'call';
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      return 'member';
    case 'ConditionalExpression':
    case 'LogicalExpression':
      return 'conditional';
    case 'TemplateLiteral':
    case 'TaggedTemplateExpression':
      return 'template';
    case 'Identifier':
      return 'identifier';
    case 'SpreadElement':
      return 'spread';
    default:
      return 'other';
  }
}

/** Map a dynamic className expression to the closest {@link ClassListForm}. */
function classFormOf(node: BabelNode): ClassListForm {
  switch (node.type) {
    case 'TemplateLiteral':
    case 'TaggedTemplateExpression':
      return 'template-literal';
    case 'CallExpression':
    case 'OptionalCallExpression':
      return 'call';
    case 'ConditionalExpression':
    case 'LogicalExpression':
      return 'conditional';
    case 'MemberExpression':
    case 'OptionalMemberExpression':
    case 'Identifier':
      return 'member';
    default:
      return 'call';
  }
}

/**
 * Find the OUTERMOST JSXElement/JSXFragment nodes that a dynamic expression renders, so the frontend
 * can lower JSX nested inside `{…}` holes — `.map`/`.filter`/`.forEach((x) => <jsx/>)` callbacks,
 * `&&`/`||` logical expressions, ternaries, and parenthesized/cast wrappers — into REAL IR element
 * nodes. The dynamic scaffolding around them (the call itself, the conditions, `{expr}` holes) stays
 * opaque; only the renderable JSX is surfaced so the pass manager descends into and optimizes it.
 *
 * Only the outermost JSX is collected: {@link buildElement}/{@link buildFragment} recurse into the
 * descendants themselves, so we must NOT descend past a JSX boundary here (that would double-register
 * inner elements).
 */
function findNestedJsxRoots(root: BabelNode): (JSXElement | JSXFragment)[] {
  const out: (JSXElement | JSXFragment)[] = [];
  const seen = new Set<BabelNode>();

  const visit = (n: BabelNode | null | undefined): void => {
    if (!n || seen.has(n)) return;
    seen.add(n);
    switch (n.type) {
      case 'JSXElement':
      case 'JSXFragment':
        out.push(n); // outermost renderable JSX — buildElement/buildFragment recurse from here
        return;
      case 'ParenthesizedExpression':
      case 'TSNonNullExpression':
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSTypeAssertion':
        visit(n.expression);
        return;
      case 'LogicalExpression':
        visit(n.left);
        visit(n.right);
        return;
      case 'ConditionalExpression':
        visit(n.consequent);
        visit(n.alternate);
        return;
      case 'SequenceExpression':
        for (const e of n.expressions) visit(e);
        return;
      case 'CallExpression':
      case 'OptionalCallExpression':
        // `.map`/`.filter`/`.forEach(cb)` etc. — descend into the call arguments (the callbacks),
        // never the callee (that is the `items.map` member access, which renders nothing).
        for (const a of n.arguments) visit(a as BabelNode);
        return;
      case 'ArrowFunctionExpression':
      case 'FunctionExpression':
        visit(n.body);
        return;
      case 'BlockStatement':
        for (const s of n.body) visit(s);
        return;
      case 'ReturnStatement':
        visit(n.argument);
        return;
      case 'IfStatement':
        visit(n.consequent);
        visit(n.alternate);
        return;
      case 'ArrayExpression':
        for (const el of n.elements) visit(el as BabelNode);
        return;
      default:
        return;
    }
  };

  visit(root);
  return out;
}

/* ───────────────────────── the frontend ───────────────────────── */

function looksLikeJsx(id: string, code: string): boolean {
  if (/\.[jt]sx$/i.test(id)) return true;
  return /<\/?[A-Za-z][\w.-]*|<>/.test(code);
}

function doParse(code: string, ctx: FrontendParseContext): ParseResult {
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

  /** Intern an expression as an opaque ExprRef, recording its verbatim source slice. */
  const internExpr = (node: Expression | JSXEmptyExpression, spread: boolean): ExprRef => {
    const payload: ExprPayload = { text: sliceOf(node), spread };
    return doc.exprs.intern({
      span: spanOf(node) ?? { file: FILE_ID, start: 0, end: 0 },
      kind: exprKind(node),
      payload,
    });
  };

  /* ----- class list ----- */

  const splitTokens = (raw: string): ClassToken[] =>
    raw
      .split(/\s+/)
      .filter((t) => t.length > 0)
      .map((value) => ({ value }) as ClassToken);

  const buildClassList = (attr: JSXAttribute): ClassList => {
    const attrSpan = spanOf(attr) ?? undefined;
    const v = attr.value;

    const staticList = (tokens: ClassToken[], valueSpan: SourceSpan | null): ClassList => {
      const seg: ClassSegment = { kind: 'static', span: valueSpan ?? undefined, tokens };
      return {
        form: 'string-literal',
        segments: [seg],
        valueSpan,
        attrSpan,
        hasDynamic: false,
        opaque: false,
        rewritable: true,
      };
    };

    if (v == null) return staticList([], null);

    if (v.type === 'StringLiteral') {
      return staticList(splitTokens(v.value), spanOf(v));
    }

    if (v.type === 'JSXExpressionContainer') {
      const expr = v.expression;
      // `className={"a b"}` is still a static string literal.
      if (expr.type === 'StringLiteral') {
        return staticList(splitTokens(expr.value), spanOf(expr));
      }
      if (expr.type === 'JSXEmptyExpression') return staticList([], null);
      const ref = internExpr(expr, false);
      const valueSpan = spanOf(expr);
      const seg: ClassSegment = { kind: 'dynamic', span: valueSpan ?? undefined, expr: ref };
      return {
        form: classFormOf(expr),
        segments: [seg],
        valueSpan,
        attrSpan,
        hasDynamic: true,
        opaque: true,
        rewritable: false,
      };
    }

    return emptyClassList();
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
        classes = buildClassList(attr);
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
    let computed: StyleMap = emptyStyleMap();
    if (!classes.hasDynamic) {
      const tokens = staticTokensOf(classes);
      if (tokens.length > 0) {
        const res = ctx.resolver.resolve({
          classes: tokens,
          element: { tagName: tag, namespace: component ? undefined : 'html' },
        });
        computed = ctx.normalizer.normalizeStyleMap(res.styles);
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
