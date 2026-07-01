/**
 * @domflax/resolver-tailwind — parse + FLATTEN Tailwind v4 `candidatesToCss` output into the same
 * flat, v3-shaped {@link TwNode} array the rest of the resolver (extract / emit / serialize) already
 * consumes. This is the ONE v4-specific adapter; everything downstream stays version-agnostic.
 *
 * ## Why a bespoke parser (no postcss)
 *
 * v4's `candidatesToCss(tokens)` returns per-token CSS in the modern NESTED authoring form, e.g.
 *
 *     .px-4        { padding-inline: calc(var(--spacing) * 4); }
 *     .container   { width: 100%; @media (width >= 40rem) { max-width: 40rem; } }
 *     .divide-y    { :where(& > :not(:last-child)) { border-top-width: …; } }
 *     .hover\:x    { &:hover { @media (hover: hover) { … } } }
 *
 * The v3 engine, by contrast, emits FLAT postcss rules (`@media { .md\:x { … } }`, and combinator
 * utilities as top-level complex-selector rules). `extract.ts` is written against that flat shape and
 * — crucially for SAFETY — classifies a combinator/`&`-nested selector as {@link OpaqueToken} so the
 * element is preserved, never treated as inert. So instead of re-teaching `extract` about nesting, we
 * FLATTEN here: resolve `&` against the parent selector, hoist `@media` into wrapping at-rules, and
 * emit exactly the flat structure v3 produces. A combinator like `divide-y` then flattens to a
 * `:where(.divide-y > …)` rule → `extract` marks it opaque → the element is kept. Bundling postcss
 * into domflax's dist is explicitly avoided (project convention), and a tiny, fail-safe parser we own
 * is unit-testable end to end.
 *
 * ## Fail-safe
 *
 * Any parse/flatten error yields `[]` (⇒ the token is reported UNKNOWN ⇒ the element is preserved).
 * We never invent declarations from malformed input.
 */

import type { TwGeneratedDecl, TwGeneratedRule, TwNode } from './types';

/* ───────────────────────── raw parse tree ───────────────────────── */

interface RawDecl {
  readonly type: 'decl';
  readonly prop: string;
  readonly value: string;
  readonly important: boolean;
}
interface RawRule {
  readonly type: 'rule';
  readonly selector: string;
  readonly nodes: RawNode[];
}
interface RawAtRule {
  readonly type: 'atrule';
  readonly name: string;
  readonly params: string;
  readonly nodes: RawNode[];
}
type RawNode = RawDecl | RawRule | RawAtRule;

/** Strip `/* … *​/` comments (v4 prepends a license banner to some output). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Turn a `prop: value` buffer into a declaration, or `null` for empties / at-statements. */
function toDecl(buffer: string): RawDecl | null {
  const buf = buffer.trim();
  if (buf.length === 0 || buf[0] === '@') return null; // `@import …;` etc. carry no element box style
  const colon = buf.indexOf(':');
  if (colon <= 0) return null;
  const prop = buf.slice(0, colon).trim();
  let value = buf.slice(colon + 1).trim();
  if (prop.length === 0 || value.length === 0) return null;
  let important = false;
  const bang = /!\s*important\s*$/i.exec(value);
  if (bang) {
    important = true;
    value = value.slice(0, bang.index).trim();
  }
  return { type: 'decl', prop, value, important };
}

/** Split a `@name params` prelude into its parts. */
function splitAtRule(prelude: string): { name: string; params: string } {
  const m = /^@([A-Za-z-]+)\s*([\s\S]*)$/.exec(prelude);
  if (!m) return { name: prelude.slice(1).trim(), params: '' };
  return { name: m[1]!.toLowerCase(), params: m[2]!.trim() };
}

/**
 * Recursive-descent block parser. Declaration values in Tailwind output never contain `{`/`}`/`;`
 * (function args use parentheses), so a plain brace/semicolon scanner is sufficient and robust.
 */
function parseBlock(src: string, start: number): { nodes: RawNode[]; next: number } {
  const nodes: RawNode[] = [];
  let buf = '';
  let i = start;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '{') {
      const prelude = buf.trim();
      buf = '';
      const inner = parseBlock(src, i + 1);
      i = inner.next;
      if (prelude.startsWith('@')) {
        const { name, params } = splitAtRule(prelude);
        nodes.push({ type: 'atrule', name, params, nodes: inner.nodes });
      } else if (prelude.length > 0) {
        nodes.push({ type: 'rule', selector: prelude, nodes: inner.nodes });
      }
    } else if (c === '}') {
      const d = toDecl(buf);
      if (d) nodes.push(d);
      return { nodes, next: i + 1 };
    } else if (c === ';') {
      const d = toDecl(buf);
      if (d) nodes.push(d);
      buf = '';
      i += 1;
    } else {
      buf += c;
      i += 1;
    }
  }
  const tail = toDecl(buf);
  if (tail) nodes.push(tail);
  return { nodes, next: i };
}

/* ───────────────────────── nesting flatten ───────────────────────── */

interface AtFrame {
  readonly name: string;
  readonly params: string;
}
interface Leaf {
  readonly selector: string;
  readonly at: readonly AtFrame[];
  readonly decls: readonly RawDecl[];
}

/** Resolve a nested selector against its parent per CSS Nesting (`&` = parent; else descendant). */
function resolveNesting(child: string, parent: string): string {
  const c = child.trim();
  if (parent.length === 0) return c;
  if (c.includes('&')) return c.split('&').join(parent);
  return `${parent} ${c}`;
}

/** At-rules that never contribute to the element's own box and carry no nested element styles. */
const DROP_ATRULES = new Set(['property', 'keyframes', 'font-face', 'charset', 'import']);

/** Recursively hoist a nested tree into flat {@link Leaf}s (selector + at-rule stack + own decls). */
function flattenNodes(nodes: readonly RawNode[], selector: string, at: readonly AtFrame[], out: Leaf[]): void {
  const own: RawDecl[] = [];
  for (const n of nodes) if (n.type === 'decl') own.push(n);
  if (own.length > 0 && selector.length > 0) out.push({ selector, at: [...at], decls: own });

  for (const n of nodes) {
    if (n.type === 'rule') {
      flattenNodes(n.nodes, resolveNesting(n.selector, selector), at, out);
    } else if (n.type === 'atrule') {
      if (n.name === 'media') {
        flattenNodes(n.nodes, selector, [...at, { name: 'media', params: n.params }], out);
      } else if (n.name === 'layer') {
        flattenNodes(n.nodes, selector, at, out); // @layer only affects cascade order → transparent
      } else if (!DROP_ATRULES.has(n.name)) {
        // @supports / @container / unknown → keep the wrapper so `extract` treats it as opaque.
        flattenNodes(n.nodes, selector, [...at, { name: n.name, params: n.params }], out);
      }
    }
  }
}

/** Build a flat {@link TwNode} (at-rule-wrapped rule) from one hoisted leaf. */
function leafToNode(leaf: Leaf): TwNode {
  const declNodes: TwGeneratedDecl[] = leaf.decls.map((d) => ({
    type: 'decl',
    prop: d.prop,
    value: d.value,
    important: d.important,
  }));
  let node: TwNode = { type: 'rule', selector: leaf.selector, nodes: declNodes } satisfies TwGeneratedRule;
  for (let i = leaf.at.length - 1; i >= 0; i -= 1) {
    node = { type: 'atrule', name: leaf.at[i]!.name, params: leaf.at[i]!.params, nodes: [node] };
  }
  return node;
}

/**
 * Parse one v4 `candidatesToCss` string and return the FLAT {@link TwNode}s (identical in shape to
 * what the v3 engine yields). Returns `[]` on any failure — the fail-safe that keeps the token
 * UNKNOWN so its element is preserved.
 */
export function parseUtilityCss(css: string): TwNode[] {
  try {
    const { nodes } = parseBlock(stripComments(css), 0);
    const leaves: Leaf[] = [];
    flattenNodes(nodes, '', [], leaves);
    return leaves.map(leafToNode);
  } catch {
    return [];
  }
}
