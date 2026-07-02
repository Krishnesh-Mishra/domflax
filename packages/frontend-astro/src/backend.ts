/**
 * @domflax/frontend-astro — IR → `.astro` backend (SURGICAL, verbatim-preserving).
 *
 * Mirrors the HTML backend: the pass manager mutates the IR lowered from the TEMPLATE region, and
 * this backend emits the SAME file back with ONLY the diffs the passes produced, applied as span
 * edits over the ORIGINAL source via `magic-string`. It NEVER re-serializes the parse5 tree. Every
 * untouched byte — the WHOLE frontmatter (never represented in the IR), components, directives,
 * expressions, comments, whitespace, attribute order — stays byte-for-byte identical. A document
 * whose template was never lowered (scoped `<style>` / malformed frontmatter passthrough) reprints
 * the retained source verbatim.
 *
 *   • CLASS CHANGE — for a surviving element whose static class list differs from its source text,
 *     overwrite just the `class` attribute VALUE span (quotes included) with the new tokens.
 *   • UNWRAP (flatten) — when a wrapper element was removed but a descendant survived, delete ONLY
 *     the wrapper's open- and close-tag spans; the children (their entire subtrees) survive verbatim.
 *   • FULL REMOVAL — when a node was removed with no surviving descendant, delete its whole span.
 */

import MagicString from 'magic-string';

import type {
  Backref,
  ClassList,
  IRDocument,
  IRElement,
  IRNode,
  IRNodeId,
  SourceFile,
  SourceSpan,
} from '@domflax/core';

/* ───────────────────────── shared helpers ───────────────────────── */

/** All static class tokens of a {@link ClassList}, in source order. */
function staticTokensOf(classes: ClassList): string[] {
  const out: string[] = [];
  for (const seg of classes.segments) {
    if (seg.kind === 'static') for (const t of seg.tokens) out.push(t.value);
  }
  return out;
}

/** Two token lists are equal iff same length and same tokens in the same order. */
function sameTokens(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

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

/** All ids the backref table knows about (every originally-parsed element with a source location). */
function backrefIds(doc: IRDocument): IRNodeId[] {
  const out: IRNodeId[] = [];
  const max = doc.alloc.peek as unknown as number;
  for (let i = 1; i < max; i += 1) {
    const id = i as IRNodeId;
    if (doc.backref.get(id)) out.push(id);
  }
  return out;
}

/* ───────────────────────── class-value rewrite ───────────────────────── */

/** The tokens currently written in the class value span (quotes/whitespace stripped). */
function currentTokens(sf: SourceFile, valueSpan: SourceSpan): string[] {
  const raw = sf.text.slice(valueSpan.start, valueSpan.end).trim();
  const unquoted = raw.replace(/^['"]/, '').replace(/['"]$/, '');
  return unquoted.split(/\s+/).filter((t) => t.length > 0);
}

/** Apply the class-list diff for one surviving element. Returns true if a byte edit was made. */
function editClasses(ms: MagicString, doc: IRDocument, sf: SourceFile, el: IRElement): boolean {
  const classes = el.classes;
  if (classes.hasDynamic || classes.opaque) return false; // never rewrite an opaque/dynamic list

  const tokens = staticTokensOf(classes);
  const valueSpan = classes.valueSpan;

  if (valueSpan && valueSpan.file === sf.id) {
    if (sameTokens(currentTokens(sf, valueSpan), tokens)) return false; // unchanged → leave verbatim
    const current = sf.text.slice(valueSpan.start, valueSpan.end).trim();
    const quote = current.startsWith("'") ? "'" : '"';
    ms.overwrite(valueSpan.start, valueSpan.end, `${quote}${tokens.join(' ')}${quote}`);
    return true;
  }

  // No class attribute originally, but the passes added classes ⇒ insert one on the opening tag.
  if (tokens.length === 0) return false;
  const openTag = doc.backref.get(el.id)?.openTagSpan;
  if (!openTag || openTag.file !== sf.id) return false;
  ms.appendLeft(openTag.start + 1 + el.tag.length, ` class="${tokens.join(' ')}"`);
  return true;
}

/* ───────────────────────── surgical codegen ───────────────────────── */

interface RemovedRegion {
  readonly backref: Backref;
  /** A surviving node nested inside this region ⇒ this was an UNWRAP (keep inner, drop tags). */
  readonly unwrapped: boolean;
}

/** Surgical whole-document codegen. Returns null when the document has no retained source. */
function surgicalPrint(doc: IRDocument): string | null {
  const sf = primarySource(doc);
  if (!sf) return null;

  const ms = new MagicString(sf.text);

  const kept = collectKept(doc);
  const keptSpans: SourceSpan[] = [];
  for (const n of kept) if (n.span && n.span.file === sf.id) keptSpans.push(n.span);

  // 1) Structural removals — an id in the backref table but absent from the live node map was removed
  //    by the passes. Classify as UNWRAP (a surviving node nests inside) or FULL removal.
  const removed: RemovedRegion[] = [];
  for (const id of backrefIds(doc)) {
    if (doc.nodes.has(id)) continue;
    const back = doc.backref.get(id);
    if (!back || back.span.file !== sf.id) continue;
    const unwrapped = keptSpans.some((k) => strictlyContains(back.span, k));
    removed.push({ backref: back, unwrapped });
  }

  // Skip any removed region nested inside a FULL-removal region (already deleted by the ancestor), so
  // every delete stays disjoint (magic-string requires it).
  const fullRemovals = removed.filter((r) => !r.unwrapped).map((r) => r.backref.span);
  for (const r of removed) {
    const s = r.backref.span;
    if (fullRemovals.some((f) => f !== s && strictlyContains(f, s))) continue;

    if (r.unwrapped) {
      const open = r.backref.openTagSpan;
      const close = r.backref.closeTagSpan;
      if (open && open.file === sf.id && open.end > open.start) ms.remove(open.start, open.end);
      if (close && close.file === sf.id && close.end > close.start) ms.remove(close.start, close.end);
    } else {
      ms.remove(s.start, s.end);
    }
  }

  // 2) Class-list diffs on every surviving element.
  for (const n of kept) if (n.kind === 'element') editClasses(ms, doc, sf, n);

  return ms.toString();
}

/** Emit the (possibly edited) document. Falls back to the empty string only for a source-less doc. */
export function doPrint(doc: IRDocument): string {
  return surgicalPrint(doc) ?? '';
}
