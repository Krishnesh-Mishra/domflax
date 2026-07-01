/**
 * @domflax/frontend-html — pure parse5 interop, constants, and opacity/span helpers.
 *
 * Stateless building blocks shared by the HTML parse pass: the minimal parse5 node/location shapes
 * this frontend reads (parse5 ships its own types, but the frontend requires it LAZILY as `unknown`,
 * so it re-declares only the slice it touches), the fixed constants, the opacity classification
 * predicates (which elements/subtrees must never be flattened or rewritten), and the source-span
 * helpers that turn parse5 location info into {@link SourceSpan}s for surgical codegen.
 *
 * No closure state, no document mutation, no third-party imports — only the `@domflax/core` type
 * contract.
 */

import type { FileKind, SourceFileId, SourceSpan } from '@domflax/core';

/** Languages this frontend claims. HTML only; JSX/TSX is owned by a sibling frontend. */
export const HTML_LANGS: readonly FileKind[] = ['html'];

/** The single registered source file id (one parse == one document). */
export const FILE_ID = 1 as SourceFileId;

/* ───────────────────────── parse5 minimal shapes (lazy-required as unknown) ───────────────────────── */

/** A `{ startOffset, endOffset }` byte range parse5 records for a node/tag/attribute. */
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

/** The tiny slice of the parse5 module surface the frontend calls. */
export interface Parse5Module {
  parse(html: string, opts: { readonly sourceCodeLocationInfo: boolean }): P5Node;
}

/* ───────────────────────── HTML detection ───────────────────────── */

/** Lightweight heuristic: does this source id / code look like HTML we can own? */
export function looksLikeHtml(id: string, code: string): boolean {
  if (/\.html?$/i.test(id)) return true;
  const head = code.slice(0, 256).trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<');
}

/* ───────────────────────── opacity classification ───────────────────────── */

/**
 * Tags whose ENTIRE subtree is opaque — never descended into, flattened, or rewritten. Raw-text /
 * embedded-content / whitespace-significant elements whose inner bytes must survive verbatim:
 * `<script>`/`<style>` (raw text + JS/CSS), `<template>` (inert content), `<svg>` (foreign markup),
 * `<pre>`/`<textarea>` (whitespace-significant).
 */
export const OPAQUE_SUBTREE_TAGS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'template',
  'svg',
  'pre',
  'textarea',
]);

export function isOpaqueSubtreeTag(tag: string): boolean {
  return OPAQUE_SUBTREE_TAGS.has(tag);
}

/**
 * Element-level opacity: an `id` (JS may `querySelector`/anchor-link it), any inline `on*=` event
 * handler, or `contenteditable` pins the element's identity/behaviour — it must never be flattened or
 * rewritten (its subtree may still be optimized).
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

/* ───────────────────────── source-span helpers ───────────────────────── */

/** A {@link SourceSpan} over `[start, end)` in the single source file. */
export function span(start: number, end: number): SourceSpan {
  return { file: FILE_ID, start, end };
}

/** The per-attribute location map, tolerating both the v6 (top-level) and v7 (`startTag`) layouts. */
export function attrsLocOf(loc: P5Location | null | undefined): Readonly<Record<string, P5Range>> | undefined {
  if (!loc) return undefined;
  return loc.startTag?.attrs ?? loc.attrs;
}

/**
 * The VALUE span (quotes included) of the `class` attribute — the splice target the backend overwrites
 * to rewrite the class list in place. Derived from the whole-attribute range (`class="…"`) by skipping
 * past the name and `=`; returns null when there is no class attribute or it has no value.
 */
export function classValueSpan(loc: P5Location | null | undefined, source: string): SourceSpan | null {
  const attrsLoc = attrsLocOf(loc);
  const cl = attrsLoc?.['class'];
  if (!cl) return null;
  const text = source.slice(cl.startOffset, cl.endOffset);
  const eq = text.indexOf('=');
  if (eq === -1) return null; // bare `class` with no value
  let i = eq + 1;
  while (i < text.length && /\s/.test(text[i]!)) i += 1;
  if (i >= text.length) return null;
  return span(cl.startOffset + i, cl.endOffset);
}
