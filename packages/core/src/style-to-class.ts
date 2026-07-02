/**
 * @domflax/core — the INLINE-STYLE ⇄ CLASS converter.
 *
 * A STATIC `style` attribute (an HTML `style="…"` string / a JSX `style={{…}}` object whose values
 * are all literals) can often be expressed as a SHORTER class: `style="padding:16px"` → `p-4` (when
 * the provider has an exactly-equivalent class) or `p-[16px]` (Tailwind arbitrary-value synthesis).
 * This module offers the style declarations to the same minimal-string exact-cover engine the class
 * compressor uses — merged with the element's class-derived style so the cover solves ONE combined
 * target — and rewrites the element only when the result is STRICTLY byte-shorter and re-resolves to
 * the exact same computed style.
 *
 * ## CASCADE SAFETY (the critical invariant)
 *
 * An inline `style` declaration beats EVERY selector (it sits above all specificity). Moving a
 * declaration into a class demotes it to class specificity, so the rewrite is only render-neutral
 * when the element's own (fully-resolved) classes are the ONLY competing source for that property.
 * A declaration is therefore converted ONLY when ALL of the following hold; otherwise it (or the
 * whole attribute) is left byte-for-byte untouched:
 *
 *   • the element's class list is fully static and every token RESOLVES (no unknown tokens — an
 *     unresolvable token means the element's true style is unknown) and NO token is opaque (an
 *     opaque token — e.g. a Tailwind combinator variant — has effects the resolver cannot model);
 *   • the property is NOT set by any NON-BASE condition block of the element's classes (a
 *     `hover:p-2` used to LOSE to the inline padding under hover; a converted base class would not);
 *   • the provider reports no SELECTOR-BOUND risk for the property on this element
 *     ({@link StyleResolver.competesWith} — the custom-CSS resolver checks bare-tag/universal/
 *     combinator/compound subjects, e.g. `div { padding: 4px }`, which classes cannot outrank);
 *   • the declaration is not `!important`, not a custom property (`--*` — descendants may read it),
 *     and the attribute parses fully statically (any dynamic value ⇒ whole attribute untouched);
 *   • the rewritten class set RE-RESOLVES to the exact combined computed style (mandatory equality
 *     backstop), and total bytes (class attribute + remaining style attribute) STRICTLY shrink.
 *
 * Elements behind any opacity barrier (spread attrs, components, floor-0 nodes, style-dirty
 * elements a flatten already rewrote) are skipped entirely. Surviving declarations stay inline
 * VERBATIM (their author text is preserved in {@link InlineStyleRawDecl.text}); an emptied
 * attribute is removed by the backends.
 */

import { conditionKey, elementIds, getElement } from './builders';
import { createSyntheticSink } from './pipeline';
import { COMPRESS_FLOOR, residualStyle } from './segment-compress';
import type {
  ClassList,
  ClassSegment,
  ClassToken,
  ConditionKey,
  CssProperty,
  EmitContext,
  InlineStyleRawDecl,
  IRDocument,
  StyleBlock,
  StyleDecl,
  StyleMap,
  StyleNormalizer,
  StyleResolver,
} from './types';

/* ───────────────────────── static style-text parsing (shared with the HTML frontend) ───────────────────────── */

/** Split a `style` attribute's text into declaration chunks on TOP-LEVEL `;` (paren/quote aware). */
function splitStyleDecls(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (const ch of text) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ';' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

const PROPERTY_RE = /^-{0,2}[a-zA-Z_][\w-]*$/;
const IMPORTANT_RE = /\s*!\s*important\s*$/i;

/**
 * Parse a static HTML `style="…"` text into {@link InlineStyleRawDecl}s (verbatim author chunks +
 * their normalized longhand expansion). Returns `null` when ANY non-empty chunk fails to parse — a
 * partially-understood attribute must never be rewritten.
 */
export function parseInlineStyleText(
  text: string,
  norm: StyleNormalizer,
): InlineStyleRawDecl[] | null {
  const raws: InlineStyleRawDecl[] = [];
  for (const chunk of splitStyleDecls(text)) {
    const trimmed = chunk.trim();
    if (trimmed.length === 0) continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) return null;
    const prop = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    if (!PROPERTY_RE.test(prop) || value.length === 0) return null;
    const important = IMPORTANT_RE.test(value);
    if (important) value = value.replace(IMPORTANT_RE, '').trim();
    if (value.length === 0) return null;
    const decls = norm.normalizeDeclaration(prop, value, important);
    if (decls.length === 0) return null;
    raws.push({ text: trimmed, decls, important });
  }
  return raws;
}

/** The final (later-wins) longhand map of a raw-decl list, or `null` on a duplicated longhand. */
export function inlineDeclMap(
  raws: readonly InlineStyleRawDecl[],
): Map<CssProperty, StyleDecl> | null {
  const map = new Map<CssProperty, StyleDecl>();
  for (const raw of raws) {
    for (const d of raw.decls) {
      // A longhand set twice (even via overlapping shorthands) makes per-decl conversion order-
      // dependent — the converter conservatively skips such attributes, so surface it as null.
      if (map.has(d.property)) return null;
      map.set(d.property, d);
    }
  }
  return map;
}

/* ───────────────────────── tiny local helpers ───────────────────────── */

/** All static class tokens of a {@link ClassList}, in source order. */
function staticTokensOf(cl: ClassList): string[] {
  const out: string[] = [];
  for (const seg of cl.segments) {
    if (seg.kind === 'static') for (const t of seg.tokens) out.push(t.value);
  }
  return out;
}

/** A rewritable static {@link ClassList} over `tokens`, preserving the previous list's spans. */
function staticClassList(prev: ClassList, tokens: readonly string[]): ClassList {
  const classTokens: ClassToken[] = tokens.map((value) => ({ value }));
  const seg: ClassSegment = { kind: 'static', tokens: classTokens };
  return {
    form: 'string-literal',
    segments: [seg],
    valueSpan: prev.valueSpan,
    attrSpan: prev.attrSpan,
    hasDynamic: false,
    opaque: false,
    rewritable: true,
  };
}

/** Merge `decls` over the BASE block of `styles` (inline wins per-property), normalized. */
function mergeInlineOverBase(
  styles: StyleMap,
  decls: readonly StyleDecl[],
  norm: StyleNormalizer,
): StyleMap {
  const blocks = new Map<ConditionKey, StyleBlock>();
  for (const [k, b] of styles.blocks) blocks.set(k, { condition: b.condition, decls: new Map(b.decls) });
  const baseKey = conditionKey({ media: '', states: [], pseudoElement: '' });
  let base = blocks.get(baseKey);
  if (!base) {
    base = { condition: { media: '', states: [], pseudoElement: '' }, decls: new Map() };
    blocks.set(baseKey, base);
  }
  const baseDecls = base.decls as Map<CssProperty, StyleDecl>;
  for (const d of decls) baseDecls.set(d.property, d);
  return norm.normalizeStyleMap({ blocks });
}

/** Serialized byte length of the REMAINING style attribute (0 when it is removed entirely). */
function remainingStyleLength(keep: readonly InlineStyleRawDecl[], frontend: string): number {
  if (keep.length === 0) return 0;
  const texts = keep.map((r) => r.text);
  // +1 for the separating space before the attribute (counted on the old side too).
  if (frontend === 'jsx') return 'style={{'.length + texts.join(', ').length + '}}'.length + 1;
  return 'style=""'.length + texts.join('; ').length + 1;
}

/* ───────────────────────── the converter ───────────────────────── */

/**
 * Convert (parts of) each eligible element's static `style` attribute into classes when strictly
 * byte-shorter and provably render-neutral (see module docs). Mutates `doc`: `el.classes`,
 * `el.computed`, `el.inlineStyle` (marked `dirty` with only the surviving raw decls) and the
 * `style` entry of `el.attrs` (removed when the attribute empties).
 */
export function convertInlineStyles(
  doc: IRDocument,
  resolver: StyleResolver,
  norm: StyleNormalizer,
): void {
  const sink = createSyntheticSink();

  for (const id of elementIds(doc)) {
    const el = getElement(doc, id);
    if (!el) continue;
    const inline = el.inlineStyle;
    if (!inline || inline.dirty || !inline.raw || inline.raw.length === 0 || !inline.span) continue;
    if (inline.dynamic && inline.dynamic.length > 0) continue;

    // Opacity barriers — anything whose true attribute/style surface is not fully static.
    if (el.meta.safetyFloor < COMPRESS_FLOOR) continue;
    if (el.isComponent || el.namespace !== 'html') continue; // component `style` is a prop, not CSS
    if (el.meta.hasSpreadAttrs || el.meta.hasUnresolvedClasses || el.meta.styleDirty) continue;
    const cl = el.classes;
    if (cl.opaque || cl.hasDynamic) continue;
    const tokens = staticTokensOf(cl);
    if (tokens.length > 0 && (!cl.rewritable || cl.valueSpan == null)) continue;

    // Full class resolution: every token must resolve and none may be opaque (an opaque token's
    // effect on this element is unmodelled ⇒ we cannot prove the converted class would still lose
    // to / win against it the way the inline style did).
    const res = resolver.resolve({
      classes: tokens,
      element: { tagName: el.tag, namespace: 'html' },
    });
    if (res.unknown.length > 0 || res.opaque.length > 0) continue;
    const classStyles = norm.normalizeStyleMap(res.styles);

    // Duplicated longhand within the attribute ⇒ conversion would be order-dependent ⇒ skip.
    if (inlineDeclMap(inline.raw) === null) continue;

    // Properties the classes set under any NON-BASE condition: the inline style used to beat those
    // variants unconditionally; a converted base class would not — such properties stay inline.
    const nonBaseProps = new Set<CssProperty>();
    const baseKey = conditionKey({ media: '', states: [], pseudoElement: '' });
    for (const [k, b] of classStyles.blocks) {
      if (k === baseKey) continue;
      for (const p of b.decls.keys()) nonBaseProps.add(p);
    }

    const convertible: InlineStyleRawDecl[] = [];
    const keep: InlineStyleRawDecl[] = [];
    for (const raw of inline.raw) {
      let ok = !raw.important;
      for (const d of raw.decls) {
        if (!ok) break;
        if (String(d.property).startsWith('--')) ok = false; // custom props: descendants may read them
        else if (nonBaseProps.has(d.property)) ok = false;
        else if (
          resolver.competesWith?.({ tagName: el.tag, classes: tokens, property: d.property }) === true
        ) {
          ok = false; // a project selector (bare tag / combinator / compound) also sets it — see docs
        }
      }
      (ok ? convertible : keep).push(raw);
    }
    if (convertible.length === 0) continue;

    // Combined target = class-derived style with the convertible inline decls merged over BASE.
    const inlineDecls = convertible.flatMap((r) => r.decls);
    const target = mergeInlineOverBase(classStyles, inlineDecls, norm);

    // Re-derive the class set exactly like reverse-emit (retained tokens verbatim, residual emitted
    // with the droppable originals as cover candidates), then the MANDATORY equality backstop.
    const isDroppable = (t: string): boolean => {
      if (!resolver.owns(t)) return false;
      const u = resolver.selectorUsage(t);
      return u.droppable || u.rebuildable === true;
    };
    const retained = tokens.filter((t) => !isDroppable(t));
    const covered = retained.length > 0 ? resolver.resolve({ classes: retained }).styles : null;
    const emitTarget = covered ? residualStyle(target, covered, norm) : target;
    const ctx: EmitContext = { normalizer: norm, sink, sourceTokens: tokens.filter(isDroppable) };
    const emitted = resolver.emit(emitTarget, ctx).classes;
    if (emitted.length === 0 && emitTarget.blocks.size > 0) continue;

    const emittedSet = new Set(emitted);
    const next: string[] = [];
    const seen = new Set<string>();
    for (const t of tokens) {
      if (seen.has(t)) continue;
      if (emittedSet.has(t) || !isDroppable(t)) {
        next.push(t);
        seen.add(t);
      }
    }
    for (const c of emitted) {
      if (seen.has(c)) continue;
      next.push(c);
      seen.add(c);
    }
    if (next.length === 0) continue;

    // MANDATORY correctness backstop: the rewritten classes must re-resolve to the EXACT combined
    // target (same condition keys, same declarations) — otherwise leave everything untouched.
    if (!norm.equals(resolver.resolve({ classes: next }).styles, target)) continue;

    // STRICT byte gate: (new class attr + remaining style attr) < (old class attr + old style attr).
    const joined = next.join(' ');
    const attrName = doc.frontend === 'jsx' ? 'className' : 'class';
    const oldClassLen = cl.valueSpan ? cl.valueSpan.end - cl.valueSpan.start : 0;
    const newClassLen = cl.valueSpan
      ? joined.length + 2 // quoted value overwrite
      : 1 + attrName.length + 2 + joined.length + 1; // ` class="…"` insertion
    const oldStyleLen = inline.span.end - inline.span.start + 1; // + the separating space
    const newStyleLen = remainingStyleLength(keep, doc.frontend);
    if (newClassLen + newStyleLen >= oldClassLen + oldStyleLen) continue;

    // COMMIT — classes, computed, the surviving inline decls (dirty ⇒ backend splices the span).
    el.classes = staticClassList(cl, next);
    el.computed = target;
    const keepDecls = new Map<CssProperty, StyleDecl>();
    for (const raw of keep) for (const d of raw.decls) keepDecls.set(d.property, d);
    el.inlineStyle = { decls: keepDecls, dynamic: null, span: inline.span, raw: keep, dirty: true };
    if (keep.length === 0 && el.attrs.entries.has('style')) {
      const entries = new Map(el.attrs.entries);
      entries.delete('style');
      el.attrs = {
        entries,
        spreads: el.attrs.spreads,
        order: el.attrs.order.filter((n) => n !== 'style'),
      };
    }
  }
}
