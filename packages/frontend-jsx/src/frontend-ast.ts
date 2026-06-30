/**
 * @domflax/frontend-jsx — AST interop, constants, and pure classification helpers.
 *
 * Stateless building blocks shared by the JSX parse pass: the `@babel/traverse`
 * default-export normalization, the frontend's fixed constants, and the pure
 * name/classification/JSX-discovery helpers (no closure state, no document mutation).
 */

import babelTraverse from '@babel/traverse';
import type {
  JSXAttribute,
  JSXElement,
  JSXFragment,
  JSXIdentifier,
  JSXMemberExpression,
  JSXNamespacedName,
  Node as BabelNode,
} from '@babel/types';

import type { ClassListForm, ExprKind, FileKind, SourceFileId } from '@domflax/core';

/* ───────────────────────── @babel/traverse interop ───────────────────────── */

// `@babel/traverse` is published as CJS (`module.exports = traverse; exports.default = traverse`).
// Under an ESM default import the value may be the function OR `{ default: fn }` depending on the
// interop layer (Node ESM vs. esbuild vs. tsup), so normalize defensively.
export const traverse = (
  typeof babelTraverse === 'function'
    ? babelTraverse
    : (babelTraverse as unknown as { default: typeof babelTraverse }).default
) as typeof babelTraverse;

/** Languages this frontend claims. JSX/TSX only; HTML is owned by a sibling frontend. */
export const JSX_LANGS: readonly FileKind[] = ['jsx', 'tsx'];

/** The single registered source file id (one parse == one module). */
export const FILE_ID = 1 as SourceFileId;

/** Marker payload stored for every interned expression so the backend can re-print it. */
export interface ExprPayload {
  readonly text: string;
  readonly spread: boolean;
}

/* ───────────────────────── name + classification helpers ───────────────────────── */

export type JSXName = JSXIdentifier | JSXMemberExpression | JSXNamespacedName;

export function jsxName(node: JSXName): string {
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
export function isComponentName(node: JSXName): boolean {
  if (node.type === 'JSXMemberExpression') return true;
  if (node.type === 'JSXNamespacedName') return false;
  return /^[A-Z]/.test(node.name);
}

export function attrName(name: JSXAttribute['name']): string {
  return name.type === 'JSXNamespacedName'
    ? `${name.namespace.name}:${name.name.name}`
    : name.name;
}

export function exprKind(node: BabelNode): ExprKind {
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
export function classFormOf(node: BabelNode): ClassListForm {
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
 * Only the outermost JSX is collected: `buildElement`/`buildFragment` recurse into the
 * descendants themselves, so we must NOT descend past a JSX boundary here (that would double-register
 * inner elements).
 */
export function findNestedJsxRoots(root: BabelNode): (JSXElement | JSXFragment)[] {
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

export function looksLikeJsx(id: string, code: string): boolean {
  if (/\.[jt]sx$/i.test(id)) return true;
  return /<\/?[A-Za-z][\w.-]*|<>/.test(code);
}
