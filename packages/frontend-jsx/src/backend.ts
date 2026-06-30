/**
 * @domflax/frontend-jsx — IR → JSX/TSX backend (SURGICAL, full-module round-trip).
 *
 * The pass manager mutates a tree of JSX *islands* that were lowered from a complete module
 * (imports, `export default function`, hooks, `return (…)`, `{expr}` holes, comments, …). The
 * backend's job is to emit a COMPLETE, valid module — not just the JSX subtree. It does this by
 * starting from the element's ORIGINAL verbatim source (retained on {@link SourceFile.text}) and
 * applying ONLY the diffs the passes produced, via `magic-string`:
 *
 *   • CLASS CHANGE — for every surviving element whose static class list differs from its source
 *     text, overwrite just the `class`/`className` attribute VALUE span (quotes included) with the
 *     new tokens. If the element gained classes but had no class attribute, insert one on the
 *     opening tag.
 *   • UNWRAP (flatten) — when a wrapper element/fragment was removed but its children survived,
 *     delete ONLY the wrapper's open- and close-tag spans; the children (and their entire subtrees,
 *     including dynamic `{expr}` holes and `key=`) are preserved verbatim.
 *   • FULL REMOVAL — when a node was removed with no surviving descendant, delete its whole span.
 *
 * Every other byte — imports, exports, function declarations, returns, hooks, `{expr}` holes,
 * whitespace, comments, attribute ordering — is left exactly as authored. Output is
 * `magicString.toString()`: a complete module.
 *
 * Fallback: a document with no retained source (e.g. a hand-synthesized IR) cannot be spliced, so
 * it falls back to a clean structural re-print ({@link rePrint}).
 */

import MagicString from 'magic-string';

import type {
  AttrValue,
  Backend,
  BackendContext,
  Backref,
  ClassList,
  CodegenResult,
  EditPlan,
  ExprRef,
  FileKind,
  IRDocument,
  IRElement,
  IRNode,
  IRNodeId,
  SourceFile,
  SourceSpan,
} from '@domflax/core';

const JSX_LANGS: readonly FileKind[] = ['jsx', 'tsx'];

interface ExprPayload {
  readonly text: string;
  readonly spread: boolean;
}

/* ───────────────────────── shared expr/class helpers ───────────────────────── */

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

/** All static class tokens of a {@link ClassList}, in order. */
function staticTokensOf(classes: ClassList): string[] {
  const out: string[] = [];
  for (const seg of classes.segments) {
    if (seg.kind === 'static') for (const t of seg.tokens) out.push(t.value);
  }
  return out;
}

/* ───────────────────────── surgical (magic-string) codegen ───────────────────────── */

/** Pick the single retained source file this document was parsed from (if any). */
function primarySource(doc: IRDocument): SourceFile | null {
  for (const sf of doc.sources.values()) {
    if (typeof sf.text === 'string' && sf.text.length > 0) return sf;
  }
  return null;
}

/** Collect every node reachable from the root of the (mutated) tree. */
function collectKept(doc: IRDocument): IRNode[] {
  const out: IRNode[] = [];
  const seen = new Set<IRNodeId>();
  const visit = (id: IRNodeId): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const n = doc.nodes.get(id);
    if (!n) return;
    out.push(n);
    if (n.kind === 'element' || n.kind === 'fragment') for (const c of n.children) visit(c);
  };
  visit(doc.root);
  return out;
}

/** Span `a` strictly contains span `b` (same file, b nested inside, not identical). */
function strictlyContains(a: SourceSpan, b: SourceSpan): boolean {
  if (a.file !== b.file) return false;
  if (a.start <= b.start && b.end <= a.end) return !(a.start === b.start && a.end === b.end);
  return false;
}

interface RemovedRegion {
  readonly backref: Backref;
  /** A surviving node nested inside this region ⇒ this was an UNWRAP (keep inner, drop tags). */
  readonly unwrapped: boolean;
}

/**
 * Apply the class-list diff for a single surviving element. Returns true if an edit was made.
 */
function editClasses(ms: MagicString, doc: IRDocument, sf: SourceFile, el: IRElement): boolean {
  const classes = el.classes;
  // Wholly dynamic / opaque class lists are never rewritten by the passes — leave verbatim.
  if (classes.hasDynamic || classes.opaque) return false;

  const tokens = staticTokensOf(classes);
  const valueSpan = classes.valueSpan;

  if (valueSpan && valueSpan.file === sf.id) {
    const current = sf.text.slice(valueSpan.start, valueSpan.end);
    // Preserve the original quote style; default to double quotes when we can't detect one.
    const quote = current.startsWith("'") ? "'" : '"';
    const next = `${quote}${tokens.join(' ')}${quote}`;
    if (current !== next) {
      ms.overwrite(valueSpan.start, valueSpan.end, next);
      return true;
    }
    return false;
  }

  // No class attribute originally, but the passes added classes ⇒ insert one on the opening tag.
  if (tokens.length === 0) return false;
  if (el.isComponent) return false; // never synthesize className onto an opaque component
  const back = doc.backref.get(el.id);
  const openTag = back?.openTagSpan;
  if (!openTag || openTag.file !== sf.id) return false;
  // Insert immediately after the tag name: `<tag‸ …`.
  const insertAt = openTag.start + 1 + el.tag.length;
  ms.appendLeft(insertAt, ` className="${tokens.join(' ')}"`);
  return true;
}

/**
 * Extract a `key=…` attribute (verbatim, e.g. `key={f.id}` or `key="row"`) from an opening-tag's
 * source text, or null when the tag carries no key. Brace/quote-aware so `key={f.id}` with nested
 * braces is captured whole. Requires whitespace before `key` so `data-key=` / `aria-keyshortcuts=`
 * never false-match.
 */
function extractKeyAttr(openTag: string): string | null {
  const m = /(^|\s)key\s*=\s*/.exec(openTag);
  if (!m) return null;
  const keyStart = m.index + m[1].length;
  let i = m.index + m[0].length;
  const ch = openTag[i];
  if (ch === '{') {
    let depth = 0;
    for (; i < openTag.length; i += 1) {
      const c = openTag[i];
      if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          break;
        }
      }
    }
  } else if (ch === '"' || ch === "'") {
    const q = ch;
    i += 1;
    for (; i < openTag.length; i += 1) {
      if (openTag[i] === q) {
        i += 1;
        break;
      }
    }
  } else {
    for (; i < openTag.length; i += 1) {
      if (/[\s>/]/.test(openTag[i]!)) break;
    }
  }
  return openTag.slice(keyStart, i);
}

/**
 * KEY SAFETY: when an UNWRAPPED wrapper carried a React `key`, that key must not vanish with the
 * deleted tags. If the wrapper had exactly one surviving (maximal) element child and that child has
 * no key of its own, transfer the wrapper's `key=…` verbatim onto the survivor's opening tag.
 * Conservative: anything ambiguous (no surviving element child, multiple survivors, child already
 * keyed) is left untouched (the flatten pattern is expected to have refused such a case).
 */
function transferKeyOnUnwrap(
  ms: MagicString,
  doc: IRDocument,
  sf: SourceFile,
  region: Backref,
  kept: readonly IRNode[],
): void {
  const open = region.openTagSpan;
  if (!open || open.file !== sf.id) return;
  const keyAttr = extractKeyAttr(sf.text.slice(open.start, open.end));
  if (!keyAttr) return;

  const inside: IRElement[] = [];
  for (const n of kept) {
    if (n.kind !== 'element' || !n.span || n.span.file !== sf.id) continue;
    if (strictlyContains(region.span, n.span)) inside.push(n);
  }
  // Keep only the topmost survivors (not nested inside another survivor of this region).
  const maximal = inside.filter(
    (n) => !inside.some((o) => o !== n && o.span && n.span && strictlyContains(o.span, n.span)),
  );
  if (maximal.length !== 1) return;

  const child = maximal[0]!;
  const childOpen = doc.backref.get(child.id)?.openTagSpan;
  if (!childOpen || childOpen.file !== sf.id) return;
  if (extractKeyAttr(sf.text.slice(childOpen.start, childOpen.end))) return; // already keyed

  // Insert immediately after the child's tag name: `<tag‸ …`.
  ms.appendLeft(childOpen.start + 1 + child.tag.length, ` ${keyAttr}`);
}

/** Surgical full-module codegen. Returns null when the document has no retained source. */
function surgicalPrint(doc: IRDocument): string | null {
  const sf = primarySource(doc);
  if (!sf) return null;

  const ms = new MagicString(sf.text);

  const kept = collectKept(doc);
  const keptSpans: SourceSpan[] = [];
  for (const n of kept) if (n.span && n.span.file === sf.id) keptSpans.push(n.span);

  // 1) Structural removals. A node present in the backref table but absent from the live node map
  //    was removed by the passes. Classify each as an UNWRAP (a surviving node nests inside it) or
  //    a FULL removal (nothing survived inside).
  const removed: RemovedRegion[] = [];
  for (const id of backrefIds(doc)) {
    if (doc.nodes.has(id)) continue; // still live
    const back = doc.backref.get(id);
    if (!back || back.span.file !== sf.id) continue;
    const unwrapped = keptSpans.some((k) => strictlyContains(back.span, k));
    removed.push({ backref: back, unwrapped });
  }

  // Skip any removed region nested inside a FULL-removal region (its bytes are already deleted by
  // the ancestor) — this keeps every delete disjoint, which magic-string requires.
  const fullRemovals = removed.filter((r) => !r.unwrapped).map((r) => r.backref.span);
  for (const r of removed) {
    const span = r.backref.span;
    const coveredByFull = fullRemovals.some((f) => f !== span && strictlyContains(f, span));
    if (coveredByFull) continue;

    if (r.unwrapped) {
      // KEY SAFETY: salvage a `key=…` off the wrapper onto its surviving child before deleting tags.
      transferKeyOnUnwrap(ms, doc, sf, r.backref, kept);
      // Delete only the wrapper's tags; keep its (surviving) inner content verbatim.
      const open = r.backref.openTagSpan;
      const close = r.backref.closeTagSpan;
      if (open && open.file === sf.id && open.end > open.start) ms.remove(open.start, open.end);
      if (close && close.file === sf.id && close.end > close.start) {
        ms.remove(close.start, close.end);
      }
    } else {
      ms.remove(span.start, span.end);
    }
  }

  // 2) Class-list diffs on every surviving element.
  for (const n of kept) {
    if (n.kind === 'element') editClasses(ms, doc, sf, n);
  }

  return ms.toString();
}

/** All ids the backref table knows about (every originally-parsed element / fragment). */
function backrefIds(doc: IRDocument): IRNodeId[] {
  // The backref table is shared verbatim from parse time; collect ids by scanning original spans we
  // recorded for live + removed nodes. We don't have a public iterator, so reconstruct the universe
  // from the live nodes plus their (now-removed) original ancestry isn't possible directly — instead
  // ask the table for each id we can reach. The table exposes `get`; the set of candidate ids is the
  // contiguous allocation range [1, alloc.peek). Scanning that range is O(n) and dependency-free.
  const out: IRNodeId[] = [];
  const max = doc.alloc.peek as unknown as number;
  for (let i = 1; i < max; i += 1) {
    const id = i as IRNodeId;
    if (doc.backref.get(id)) out.push(id);
  }
  return out;
}

/* ───────────────────────── structural re-print (fallback) ───────────────────────── */

/** Re-build the `className=…` attribute (or null when the element has no class list). */
function classText(doc: IRDocument, classes: ClassList): string | null {
  if (classes.form === 'absent' || classes.segments.length === 0) return null;

  const dynamic = classes.segments.find((s) => s.kind === 'dynamic');
  if (dynamic && dynamic.kind === 'dynamic') {
    return `className={${exprText(doc, dynamic.expr).text}}`;
  }

  const tokens = staticTokensOf(classes);
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

  for (const ref of el.attrs.spreads) parts.push(`{...${exprText(doc, ref).text}}`);

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

function rePrint(doc: IRDocument): string {
  const root = doc.nodes.get(doc.root);
  if (!root || root.kind !== 'fragment') return printNode(doc, doc.root);
  return root.children.map((c) => printNode(doc, c)).join('');
}

/* ───────────────────────── public backend ───────────────────────── */

function doPrint(doc: IRDocument): string {
  const surgical = surgicalPrint(doc);
  return surgical ?? rePrint(doc);
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
