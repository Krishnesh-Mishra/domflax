/**
 * @domflax/resolver-tailwind — selector / condition parsing.
 */

import type { StyleCondition } from '@domflax/core';

/** Pseudo-elements that Tailwind may emit with a legacy single colon. */
const LEGACY_PSEUDO_ELEMENTS = new Set([
  ':before',
  ':after',
  ':first-line',
  ':first-letter',
]);

export type ParsedSelector =
  | { readonly kind: 'simple'; readonly states: readonly string[]; readonly pseudoElement: string }
  | { readonly kind: 'complex' };

/**
 * Parse a generated selector into a {@link StyleCondition} fragment. Accepts ONLY a single class
 * selector optionally followed by pseudo-class / pseudo-element parts (`.x`, `.x:hover`,
 * `.x::before`, `.x:focus:hover`). Anything with a combinator, a second compound class, an attribute
 * selector, or a selector list is `complex` (⇒ opaque) because its declarations do not apply to the
 * element's own box.
 */
export function parseSelector(selector: string): ParsedSelector {
  const sel = selector.trim();
  if (sel.length === 0 || sel[0] !== '.') return { kind: 'complex' };

  // Consume the class identifier, honoring CSS backslash escapes (`\:`, `\/`, `\[`, …).
  let i = 1;
  for (; i < sel.length; i += 1) {
    const c = sel[i]!;
    if (c === '\\') {
      i += 1; // skip the escaped char
      continue;
    }
    if (c === ':' || c === '.' || c === '[' || c === ' ' || c === '>' || c === '+' || c === '~' || c === ',') {
      break;
    }
  }

  const remainder = sel.slice(i);
  if (remainder.length === 0) {
    return { kind: 'simple', states: [], pseudoElement: '' };
  }
  // The remainder must be EXCLUSIVELY pseudo parts — no combinator / compound / attribute follows.
  if (!/^(?:::?[-a-z]+(?:\([^()]*\))?)+$/i.test(remainder)) {
    return { kind: 'complex' };
  }

  const parts = remainder.match(/::?[-a-z]+(?:\([^()]*\))?/gi) ?? [];
  const states: string[] = [];
  let pseudoElement = '';
  for (const part of parts) {
    if (part.startsWith('::') || LEGACY_PSEUDO_ELEMENTS.has(part)) {
      pseudoElement = part.startsWith('::') ? part : `:${part}`;
    } else {
      states.push(part);
    }
  }
  return { kind: 'simple', states, pseudoElement };
}

export function makeCondition(media: string, states: readonly string[], pseudoElement: string): StyleCondition {
  return {
    media,
    states: [...new Set(states)].sort(),
    pseudoElement,
  };
}

/** Recover a class name from a simple `.escaped-class` selector, or `null` if it isn't simple. */
export function unescapeClass(selector: string): string | null {
  const sel = selector.trim();
  if (sel[0] !== '.') return null;
  let out = '';
  for (let i = 1; i < sel.length; i += 1) {
    const c = sel[i]!;
    if (c === '\\') {
      i += 1;
      if (i < sel.length) out += sel[i];
      continue;
    }
    if (c === ':' || c === '.' || c === '[' || c === ' ' || c === '>' || c === '+' || c === '~' || c === ',') {
      return null; // not a bare single-class selector
    }
    out += c;
  }
  return out.length > 0 ? out : null;
}
