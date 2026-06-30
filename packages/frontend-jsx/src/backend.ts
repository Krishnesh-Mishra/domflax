/**
 * @domflax/frontend-jsx — IR → JSX/TSX backend (CORRECTNESS-FIRST re-print).
 *
 * Walks the (possibly mutated) {@link IRDocument} and emits valid, equivalent JSX/TSX text:
 *   • intrinsic tags keep their (lowercase) name, components keep their (capitalized/member) name;
 *   • `className` is rebuilt from the {@link ClassList} tokens (static) or its dynamic ExprRef;
 *   • other attributes re-print from the {@link AttrMap} (static string/boolean or dynamic ExprRef);
 *   • spreads re-print as `{...expr}`; children recurse; an {@link IRExpr} re-prints from its
 *     registry source slice as `{expr}` (or `{...expr}` for a spread child); {@link IRText} prints
 *     verbatim (so original whitespace/formatting is preserved across untouched regions).
 *
 * This is a clean full re-print — NOT surgical magic-string span-splicing. Minimal-diff codegen
 * (replaying the EditPlan's ops against retained source via BackrefTable spans) is a later
 * refinement; the goal here is output that is valid and semantically equivalent to the IR.
 *
 * Known limitation (documented, not faked): original attribute ordering relative to spreads is not
 * preserved — `className` is emitted first, then ordered attributes, then spreads. For non-
 * conflicting props this is semantically equivalent.
 */

import type {
  AttrValue,
  Backend,
  BackendContext,
  ClassList,
  CodegenResult,
  EditPlan,
  ExprRef,
  FileKind,
  IRDocument,
  IRElement,
  IRNodeId,
} from '@domflax/core';

const JSX_LANGS: readonly FileKind[] = ['jsx', 'tsx'];

interface ExprPayload {
  readonly text: string;
  readonly spread: boolean;
}

/** Recover an interned expression's source text (payload first, span-slice fallback). */
function exprText(doc: IRDocument, ref: ExprRef): ExprPayload {
  const rec = doc.exprs.get(ref);
  const payload = rec?.payload as Partial<ExprPayload> | undefined;
  if (payload && typeof payload.text === 'string') {
    return { text: payload.text, spread: payload.spread === true };
  }
  if (rec) {
    const sf = doc.sources.get(rec.span.file);
    if (sf) return { text: sf.text.slice(rec.span.start, rec.span.end), spread: false };
  }
  return { text: '', spread: false };
}

/** Re-build the `className=…` attribute (or null when the element has no class list). */
function classText(doc: IRDocument, classes: ClassList): string | null {
  if (classes.form === 'absent' || classes.segments.length === 0) return null;

  const dynamic = classes.segments.find((s) => s.kind === 'dynamic');
  if (dynamic && dynamic.kind === 'dynamic') {
    return `className={${exprText(doc, dynamic.expr).text}}`;
  }

  const tokens: string[] = [];
  for (const seg of classes.segments) {
    if (seg.kind === 'static') for (const t of seg.tokens) tokens.push(t.value);
  }
  return `className="${tokens.join(' ')}"`;
}

function attrText(doc: IRDocument, name: string, value: AttrValue): string {
  if (value.kind === 'static') {
    if (value.value === true) return name;
    if (value.value === false) return '';
    return `${name}="${String(value.value)}"`;
  }
  return `${name}={${exprText(doc, value.expr).text}}`;
}

function printElement(doc: IRDocument, el: IRElement): string {
  const parts: string[] = [];

  const cls = classText(doc, el.classes);
  if (cls !== null) parts.push(cls);

  for (const name of el.attrs.order) {
    const v = el.attrs.entries.get(name);
    if (!v) continue;
    const text = attrText(doc, name, v);
    if (text.length > 0) parts.push(text);
  }

  for (const ref of el.attrs.spreads) {
    parts.push(`{...${exprText(doc, ref).text}}`);
  }

  const attrStr = parts.length > 0 ? ` ${parts.join(' ')}` : '';
  const tag = el.tag;

  if (el.children.length === 0) {
    return el.selfClosing ? `<${tag}${attrStr} />` : `<${tag}${attrStr}></${tag}>`;
  }

  const inner = el.children.map((c) => printNode(doc, c)).join('');
  return `<${tag}${attrStr}>${inner}</${tag}>`;
}

function printNode(doc: IRDocument, id: IRNodeId): string {
  const node = doc.nodes.get(id);
  if (!node) return '';
  switch (node.kind) {
    case 'text':
      return node.value;
    case 'comment':
      return `{/*${node.value}*/}`;
    case 'expr': {
      const { text, spread } = exprText(doc, node.expr);
      return spread ? `{...${text}}` : `{${text}}`;
    }
    case 'fragment':
      return `<>${node.children.map((c) => printNode(doc, c)).join('')}</>`;
    case 'element':
      return printElement(doc, node);
  }
}

function doPrint(doc: IRDocument): string {
  const root = doc.nodes.get(doc.root);
  if (!root || root.kind !== 'fragment') return printNode(doc, doc.root);
  // The document root is an implicit fragment: print its children with no `<>` wrapper.
  return root.children.map((c) => printNode(doc, c)).join('');
}

export const jsxBackend: Backend = {
  name: 'babel-jsx',
  langs: JSX_LANGS,
  print(doc: IRDocument, _plan: EditPlan, _ctx: BackendContext): CodegenResult {
    const code = doPrint(doc);
    return { code, map: null, edits: [], diagnostics: [] };
  },
};

/** Factory mirror — returns a fresh handle to the (stateless) JSX backend. */
export function createJsxBackend(): Backend {
  return jsxBackend;
}
