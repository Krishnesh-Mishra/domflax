/**
 * @domflax/frontend-vue — opacity classification + tag-span derivation for template AST elements.
 *
 * CONSERVATIVE BY CONSTRUCTION: anything Vue-reactive or identity-bearing is opaque, and anything the
 * classifier is unsure about degrades to "preserve verbatim". Two tiers:
 *
 *   • SUBTREE-OPAQUE — the element AND everything under it are never represented as optimizable IR
 *     (not descended into; every inner byte survives verbatim): component tags / `<slot>` / nested
 *     `<template>`, non-HTML namespaces (svg/mathml), raw-text & whitespace-significant tags, and ANY
 *     directive (`v-*`, and the `:` / `@` / `#` / `.` shorthands — matched both as parsed
 *     DirectiveNodes and defensively by attribute NAME, which also catches `v-pre`-suspended syntax).
 *   • ELEMENT-OPAQUE — the element itself is never flattened/rewritten but its children still lower
 *     normally: `id` (querySelector/anchor target), inline `on*=` handlers, `contenteditable`, and
 *     Vue's static `ref` / `key` attributes.
 *
 * Also derives the open-/close-tag spans (compiler-core does not record them) with a quote-aware
 * scan; a failed derivation yields null and the backend then never structurally edits that element.
 */

import type { SourceSpan } from '@domflax/core';

import type { TplAttributeNode, TplElementNode, TplProp } from './sfc';
import { span, TPL, TPL_TAG } from './sfc';

/* ───────────────────────── opacity classification ───────────────────────── */

/**
 * Tags whose ENTIRE subtree is opaque (mirrors the HTML frontend): raw-text / embedded-content /
 * whitespace-significant elements whose inner bytes must survive verbatim.
 */
export const OPAQUE_SUBTREE_TAGS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'template',
  'svg',
  'math',
  'pre',
  'textarea',
  'slot',
]);

/** Directive syntax by attribute NAME: `v-*` and the `:`/`@`/`#`/`.` shorthands. */
export function isDirectiveSyntaxName(name: string): boolean {
  return /^(?:v-|[:@#.])/.test(name);
}

/** Static attribute props only (type-narrowing helper). */
export function staticAttrsOf(el: TplElementNode): TplAttributeNode[] {
  const out: TplAttributeNode[] = [];
  for (const p of el.props) if (p.type === TPL.ATTRIBUTE) out.push(p);
  return out;
}

/** True when any prop is a parsed directive OR spells directive syntax in its name. */
export function hasAnyDirective(props: readonly TplProp[]): boolean {
  for (const p of props) {
    if (p.type === TPL.DIRECTIVE) return true;
    if (isDirectiveSyntaxName(p.name)) return true;
  }
  return false;
}

/**
 * SUBTREE opacity: component / `<slot>` / nested `<template>` tags, non-HTML namespaces, raw-text
 * tags, or ANY directive on the element. Such an element is preserved verbatim and never descended
 * into (a structural directive like `v-if`/`v-for` re-shapes the subtree at runtime, and `v-pre`
 * suspends compilation below it — both make every child un-optimizable without evaluation).
 */
export function isOpaqueSubtree(el: TplElementNode): boolean {
  if (el.tagType !== TPL_TAG.ELEMENT) return true;
  if (el.ns !== 0) return true;
  if (OPAQUE_SUBTREE_TAGS.has(el.tag.toLowerCase())) return true;
  return hasAnyDirective(el.props);
}

/**
 * ELEMENT opacity (subtree still lowered): identity/behaviour-pinning static attributes — `id`,
 * inline `on*=` handlers, `contenteditable`, and Vue's static `ref`/`key`.
 */
export function elementIsOpaque(attrs: readonly TplAttributeNode[]): boolean {
  for (const a of attrs) {
    const n = a.name.toLowerCase();
    if (n === 'id' || n === 'contenteditable' || n === 'ref' || n === 'key') return true;
    if (n.startsWith('on')) return true;
  }
  return false;
}

/** True when the element carries a static inline `on*=` event handler. */
export function hasEventHandler(props: readonly TplProp[]): boolean {
  for (const p of props) {
    if (p.type === TPL.DIRECTIVE && p.name === 'on') return true;
    if (/^(?:on|@)/i.test(p.name)) return true;
  }
  return false;
}

/* ───────────────────────── tag-span derivation ───────────────────────── */

/**
 * The OPEN-TAG span `[start, i)` of an element whose source starts at `start` (`<`): a quote-aware
 * scan to the first `>` outside single/double quotes (attribute values may contain `>`). Returns null
 * when no terminator is found inside the element's own span — the caller then treats the element as
 * structurally unedittable.
 */
export function openTagSpan(source: string, start: number, end: number): SourceSpan | null {
  if (source.charCodeAt(start) !== 0x3c /* < */) return null;
  let quote: string | null = null;
  for (let i = start; i < end; i += 1) {
    const ch = source[i]!;
    if (quote != null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return span(start, i + 1);
  }
  return null;
}

/**
 * The CLOSE-TAG span of an element occupying `[start, end)`: the trailing `</tag …>` suffix of the
 * element's own source text. Null for self-closing / void elements (no end tag present).
 */
export function closeTagSpan(
  source: string,
  start: number,
  end: number,
  tag: string,
): SourceSpan | null {
  const text = source.slice(start, end);
  const m = new RegExp(`</${escapeRegExp(tag)}\\s*>$`, 'i').exec(text);
  if (!m) return null;
  return span(start + m.index, end);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The VALUE span (quotes included) of a static `class` attribute — the splice target the backend
 * overwrites to rewrite the class list in place. compiler-core records the value location directly
 * (its `loc.source` includes the quotes); null when the attribute is bare (`class` with no value).
 */
export function classValueSpan(attr: TplAttributeNode): SourceSpan | null {
  const v = attr.value;
  if (!v) return null;
  return span(v.loc.start.offset, v.loc.end.offset);
}
