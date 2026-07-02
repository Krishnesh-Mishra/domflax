/**
 * @domflax/frontend-astro — pure parse5 interop, constants, and Astro opacity/span helpers.
 *
 * Stateless building blocks shared by the Astro parse pass: the minimal parse5 node/location shapes
 * this frontend reads (parse5 is required LAZILY as `unknown`, so only the touched slice is declared),
 * the fixed constants, the Astro-specific opacity classification predicates (components, directives,
 * spreads, `{expr}` dynamics — anything that must never be flattened or rewritten), and the
 * OFFSET-AWARE source-span helpers that turn parse5 fragment locations (relative to the TEMPLATE
 * region) into absolute {@link SourceSpan}s over the whole `.astro` file.
 *
 * No closure state, no document mutation, no third-party imports — only the `@domflax/core` type
 * contract.
 */

import type { FileKind, SourceFileId, SourceSpan } from '@domflax/core';

/**
 * Languages this frontend claims. Core has no dedicated `astro` {@link FileKind} yet, so `.astro`
 * inputs arrive classified as `unknown`; the REAL gate is {@link looksLikeAstro} in `canParse`.
 */
export const ASTRO_LANGS: readonly FileKind[] = ['unknown'];

/** The single registered source file id (one parse == one component). */
export const FILE_ID = 1 as SourceFileId;

/* ───────────────────────── parse5 minimal shapes (lazy-required as unknown) ───────────────────────── */

/** A `{ startOffset, endOffset }` range parse5 records for a node/tag/attribute. */
export interface P5Range {
  readonly startOffset: number;
  readonly endOffset: number;
}

/** parse5 element start-tag location (parse5 v7 nests per-attribute ranges under `startTag.attrs`). */
export interface P5TagLoc extends P5Range {
  readonly attrs?: Readonly<Record<string, P5Range>>;
}

/** parse5 element source-code location. `attrs` may live at the top level (v6) or under `startTag` (v7). */
export interface P5Location extends P5Range {
  readonly startTag?: P5TagLoc | null;
  readonly endTag?: P5Range | null;
  readonly attrs?: Readonly<Record<string, P5Range>>;
}

export interface P5Attr {
  readonly name: string;
  readonly value: string;
}

export interface P5Node {
  readonly nodeName: string;
  readonly tagName?: string;
  readonly value?: string; // #text
  readonly data?: string; // #comment
  readonly attrs?: readonly P5Attr[];
  readonly childNodes?: readonly P5Node[];
  readonly sourceCodeLocation?: P5Location | null;
}

/** The tiny slice of the parse5 module surface the frontend calls (fragment parsing only). */
export interface Parse5Module {
  parseFragment(html: string, opts: { readonly sourceCodeLocationInfo: boolean }): P5Node;
}

/* ───────────────────────── Astro detection ───────────────────────── */

/** `.astro` files only — the file extension is the single authoritative signal. */
export function looksLikeAstro(id: string, _code: string): boolean {
  return /\.astro$/i.test(id);
}

/* ───────────────────────── opacity classification ───────────────────────── */

/**
 * Tags whose ENTIRE subtree is opaque — never descended into, flattened, or rewritten. The HTML set
 * (raw-text / embedded-content / whitespace-significant elements) plus Astro's `<slot>`, whose
 * rendered children are decided by the CONSUMER of the component, not this file.
 */
export const OPAQUE_SUBTREE_TAGS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'template',
  'svg',
  'pre',
  'textarea',
  'slot',
]);

export function isOpaqueSubtreeTag(tag: string): boolean {
  return OPAQUE_SUBTREE_TAGS.has(tag);
}

/**
 * Component detection from the SOURCE open-tag text. parse5 lowercases `tagName`
 * (`<Card>` → `card`), so the original casing is recoverable only from the source bytes: an
 * uppercase first letter (`<Card`) or a dotted name (`<ns.Component`) marks an Astro component.
 */
export function isComponentOpenTag(openTagText: string): boolean {
  const m = /^<\s*([^\s/>]+)/.exec(openTagText);
  const name = m?.[1] ?? '';
  return /^[A-Z]/.test(name) || name.includes('.');
}

/** The open tag was WRITTEN self-closing (`… />`) — Astro treats such an element as childless. */
export function isSelfClosingOpenTag(openTagText: string): boolean {
  return /\/>$/.test(openTagText);
}

/**
 * Any Astro directive — `client:*`, `set:*`, `is:*`, `define:*`, `class:list`, `transition:*`, … —
 * makes the element opaque. Conservatively, ANY attribute name containing `:` counts (an unknown
 * namespaced attribute is exactly the "uncertain" case that must be preserved).
 */
export function hasDirectiveAttr(attrs: readonly P5Attr[]): boolean {
  for (const a of attrs) if (a.name.includes(':')) return true;
  return false;
}

/** A spread (`{...props}`) parses as an attribute whose NAME contains `{`. */
export function hasSpreadAttr(attrs: readonly P5Attr[]): boolean {
  for (const a of attrs) if (a.name.includes('{')) return true;
  return false;
}

/** Any attribute VALUE containing `{` is (or may be) an Astro expression → dynamic-opaque element. */
export function hasDynamicAttrValue(attrs: readonly P5Attr[]): boolean {
  for (const a of attrs) if (a.value.includes('{')) return true;
  return false;
}

/**
 * Element-level opacity shared with the HTML frontend: an `id` (JS/`querySelector`/anchor target,
 * and Astro scoped-selector hook), any inline `on*=` handler, or `contenteditable` pins the
 * element's identity/behaviour.
 */
export function elementIsOpaque(attrs: readonly P5Attr[]): boolean {
  for (const a of attrs) {
    const n = a.name.toLowerCase();
    if (n === 'id' || n === 'contenteditable') return true;
    if (n.startsWith('on')) return true;
  }
  return false;
}

/** True when the element carries any inline `on*=` event handler. */
export function hasEventHandler(attrs: readonly P5Attr[]): boolean {
  for (const a of attrs) if (/^on/i.test(a.name)) return true;
  return false;
}

/* ───────────────────────── `{expr}` text classification ───────────────────────── */

/** The text contains a curly brace — it is (or borders) an Astro expression. */
export function containsBrace(text: string): boolean {
  return text.includes('{') || text.includes('}');
}

/**
 * True iff every `{` in the text closes and the depth never goes negative — i.e. every expression is
 * SELF-CONTAINED within this one text node. When a brace-carrying text node is UNBALANCED, an
 * expression spans across sibling nodes (`{cond && <span>…</span>}` — parse5 lifts the inner tag out
 * as a sibling element), so every element sibling must be treated as opaque. Braces inside JS string
 * literals may miscount, but only toward "unbalanced" → opaque, which is the safe direction.
 */
export function bracesBalanced(text: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/* ───────────────────────── offset-aware source-span helpers ───────────────────────── */

/** A {@link SourceSpan} over `[start, end)` in the single source file (absolute offsets). */
export function span(start: number, end: number): SourceSpan {
  return { file: FILE_ID, start, end };
}

/** Lift a parse5 TEMPLATE-relative range to an absolute file span by adding the region `base`. */
export function spanAt(base: number, r: P5Range): SourceSpan {
  return span(base + r.startOffset, base + r.endOffset);
}

/** The per-attribute location map, tolerating both the v6 (top-level) and v7 (`startTag`) layouts. */
export function attrsLocOf(loc: P5Location | null | undefined): Readonly<Record<string, P5Range>> | undefined {
  if (!loc) return undefined;
  return loc.startTag?.attrs ?? loc.attrs;
}

/**
 * The ABSOLUTE VALUE span (quotes included) of the `class` attribute — the splice target the backend
 * overwrites to rewrite the class list in place. `template` is the sliced template-region text and
 * `base` its offset in the full file; parse5 ranges are relative to `template`.
 */
export function classValueSpan(
  loc: P5Location | null | undefined,
  template: string,
  base: number,
): SourceSpan | null {
  const attrsLoc = attrsLocOf(loc);
  const cl = attrsLoc?.['class'];
  if (!cl) return null;
  const text = template.slice(cl.startOffset, cl.endOffset);
  const eq = text.indexOf('=');
  if (eq === -1) return null; // bare `class` with no value
  let i = eq + 1;
  while (i < text.length && /\s/.test(text[i]!)) i += 1;
  if (i >= text.length) return null;
  return span(base + cl.startOffset + i, base + cl.endOffset);
}
