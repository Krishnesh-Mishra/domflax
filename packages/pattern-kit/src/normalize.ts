/**
 * @domflax/pattern-kit — the shared StyleMap normalizer.
 *
 * A single, syntactic-only {@link StyleNormalizer} implementation that core, the patterns, and the
 * verifier all reuse so they agree, byte-for-byte, on what two style declarations "mean". It NEVER
 * resolves initial/inherited/computed defaults (that is the verifier's job) — it only:
 *
 *   • canonicalizes colors (`transparent` ⇒ `rgba(0, 0, 0, 0)`, hex lower-cased + 3→6 expanded,
 *     `rgb()/rgba()/hsl()/hsla()` argument spacing normalized),
 *   • canonicalizes units (whitespace collapsed, zero-lengths `0px`/`0%`/… ⇒ `0`),
 *   • expands a fixed set of box shorthands to longhands (`padding`/`margin`/`inset`/`border-width`
 *     into their four sides, `gap` into `row-gap`/`column-gap`),
 *   • orders declarations by property for stable comparison.
 *
 * Dependency-free: only `@domflax/core` (types + the StyleMap builder helpers).
 */

import type {
  CssProperty,
  CssValue,
  ConditionKey,
  InheritedPropertyTable,
  StyleBlock,
  StyleDecl,
  StyleMap,
  StyleNormalizer,
} from '@domflax/core';

import { conditionKey, emptyStyleMap } from '@domflax/core';

/* ───────────────────────── inherited-property table ───────────────────────── */

/**
 * Canonical, versioned set of inherited CSS longhands. Any author custom property (`--*`) is
 * also treated as inherited via the `isInherited` predicate.
 */
const INHERITED_PROPERTIES: readonly string[] = [
  'azimuth',
  'border-collapse',
  'border-spacing',
  'caption-side',
  'color',
  'cursor',
  'direction',
  'empty-cells',
  'font-family',
  'font-feature-settings',
  'font-kerning',
  'font-size',
  'font-size-adjust',
  'font-stretch',
  'font-style',
  'font-variant',
  'font-variant-caps',
  'font-variant-numeric',
  'font-weight',
  'hyphens',
  'letter-spacing',
  'line-height',
  'list-style-image',
  'list-style-position',
  'list-style-type',
  'orphans',
  'overflow-wrap',
  'quotes',
  'tab-size',
  'text-align',
  'text-align-last',
  'text-decoration-color',
  'text-indent',
  'text-justify',
  'text-rendering',
  'text-shadow',
  'text-transform',
  'text-underline-position',
  'visibility',
  'white-space',
  'widows',
  'word-break',
  'word-spacing',
  'writing-mode',
  '-webkit-font-smoothing',
];

function createInheritedTable(): InheritedPropertyTable {
  const properties = new Set<CssProperty>(INHERITED_PROPERTIES as unknown as CssProperty[]);
  return {
    version: 'domflax-inherited@1',
    properties,
    isInherited(property: CssProperty): boolean {
      // Author custom properties (`--*`) inherit by definition.
      return String(property).startsWith('--') || properties.has(property);
    },
  };
}

/* ───────────────────────── value canonicalization ───────────────────────── */

const ZERO_LENGTH_RE =
  /\b0(?:px|em|rem|ex|ch|vh|vw|vmin|vmax|vi|vb|pt|pc|cm|mm|in|q|lh|rlh|fr|deg|rad|turn|s|ms|%)\b/g;

const FUNC_ARGS_RE = /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(([^()]*)\)/gi;

const RELATIVE_UNIT_RE = /(?:\d*\.?\d+)(?:em|ex|ch|lh)\b|%/i;

/**
 * Pure, syntactic value canonicalization. Idempotent: `canon(canon(v)) === canon(v)`.
 */
function canonValue(raw: string): string {
  let v = raw.trim().replace(/\s+/g, ' ');

  // Lower-case hex colors (#abc / #aabbcc / #aabbccff).
  v = v.replace(/#([0-9a-fA-F]{3,8})\b/g, (_m, hex: string) => '#' + hex.toLowerCase());

  // Expand 3-digit hex (#abc → #aabbcc) — only when exactly 3 hex digits.
  v = v.replace(
    /#([0-9a-f])([0-9a-f])([0-9a-f])(?![0-9a-f])/g,
    (_m, r: string, g: string, b: string) => `#${r}${r}${g}${g}${b}${b}`,
  );

  // Canonical fully-transparent color.
  v = v.replace(/\btransparent\b/gi, 'rgba(0, 0, 0, 0)');
  v = v.replace(/#00000000\b/g, 'rgba(0, 0, 0, 0)');

  // Collapse zero lengths/angles/times to a bare `0`.
  v = v.replace(ZERO_LENGTH_RE, '0');

  // Normalize the argument spacing of color/space functions: single space after each comma.
  v = v.replace(FUNC_ARGS_RE, (_m, fn: string, args: string) => {
    const parts = args
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return `${fn.toLowerCase()}(${parts.join(', ')})`;
  });

  return v;
}

/** True when the (canonicalized) value uses a parent-relative unit (em/ex/ch/lh/%). */
function isRelativeValue(value: string): boolean {
  return RELATIVE_UNIT_RE.test(value);
}

/* ───────────────────────── shorthand expansion ───────────────────────── */

/** Box-model shorthands whose 1–4 value form expands to four explicit sides. */
const BOX_SIDES: Readonly<Record<string, readonly [string, string, string, string]>> = {
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  inset: ['top', 'right', 'bottom', 'left'],
  'border-width': [
    'border-top-width',
    'border-right-width',
    'border-bottom-width',
    'border-left-width',
  ],
  'border-style': [
    'border-top-style',
    'border-right-style',
    'border-bottom-style',
    'border-left-style',
  ],
  'border-color': [
    'border-top-color',
    'border-right-color',
    'border-bottom-color',
    'border-left-color',
  ],
};

/** Split on top-level whitespace, keeping `fn(a, b)` groups intact. */
function splitTopLevel(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && /\s/.test(ch)) {
      if (cur.length > 0) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** Map a 1–4 value box shorthand onto its [top, right, bottom, left] sides. */
function boxFourSides(values: readonly string[]): [string, string, string, string] {
  const [a, b, c, d] = values;
  switch (values.length) {
    case 1:
      return [a!, a!, a!, a!];
    case 2:
      return [a!, b!, a!, b!];
    case 3:
      return [a!, b!, c!, b!];
    default:
      return [a!, b!, c!, d!];
  }
}

/** Expand one declaration into longhand `[property, value]` pairs (single pair if not shorthand). */
function expandShorthand(prop: string, value: string): Array<[string, string]> {
  const box = BOX_SIDES[prop];
  if (box) {
    const parts = splitTopLevel(value);
    if (parts.length >= 1 && parts.length <= 4) {
      const sides = boxFourSides(parts);
      return box.map((p, i) => [p, sides[i]!] as [string, string]);
    }
    return [[prop, value]];
  }

  if (prop === 'gap' || prop === 'grid-gap') {
    const parts = splitTopLevel(value);
    if (parts.length === 1) {
      return [
        ['row-gap', parts[0]!],
        ['column-gap', parts[0]!],
      ];
    }
    if (parts.length === 2) {
      return [
        ['row-gap', parts[0]!],
        ['column-gap', parts[1]!],
      ];
    }
    return [[prop, value]];
  }

  return [[prop, value]];
}

/* ───────────────────────── the normalizer ───────────────────────── */

function makeDecl(
  table: InheritedPropertyTable,
  prop: string,
  rawValue: string,
  important: boolean,
): StyleDecl {
  const property = prop.trim().toLowerCase() as CssProperty;
  const value = canonValue(rawValue) as CssValue;
  return {
    property,
    value,
    important,
    relativeToParent: isRelativeValue(value),
    inherited: table.isInherited(property),
  };
}

export function createNormalizer(): StyleNormalizer {
  const inherited = createInheritedTable();

  const normalizeDeclaration = (
    prop: string,
    value: string,
    important: boolean,
  ): readonly StyleDecl[] => {
    const p = prop.trim().toLowerCase();
    const expanded = expandShorthand(p, value.trim());
    return expanded.map(([lp, lv]) => makeDecl(inherited, lp, lv, important));
  };

  const normalizeValue = (prop: CssProperty, raw: string): CssValue => {
    void prop;
    return canonValue(raw) as CssValue;
  };

  const normalizeStyleMap = (sm: StyleMap): StyleMap => {
    const blocks = new Map<ConditionKey, StyleBlock>();
    for (const block of sm.blocks.values()) {
      const decls = new Map<CssProperty, StyleDecl>();
      // Re-canonicalize every value and re-key (the decls are already longhand).
      for (const decl of block.decls.values()) {
        const next: StyleDecl = {
          ...decl,
          value: canonValue(String(decl.value)) as CssValue,
          relativeToParent: isRelativeValue(String(decl.value)),
          inherited: inherited.isInherited(decl.property),
        };
        decls.set(next.property, next);
      }
      // Property-sorted for deterministic iteration/serialization.
      const sorted = new Map<CssProperty, StyleDecl>(
        [...decls.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
      );
      const key = conditionKey(block.condition);
      blocks.set(key, { condition: block.condition, decls: sorted });
    }
    return { blocks };
  };

  const equals = (a: StyleMap, b: StyleMap): boolean => {
    const na = normalizeStyleMap(a);
    const nb = normalizeStyleMap(b);
    if (na.blocks.size !== nb.blocks.size) return false;
    for (const [key, blockA] of na.blocks) {
      const blockB = nb.blocks.get(key);
      if (!blockB) return false;
      if (blockA.decls.size !== blockB.decls.size) return false;
      for (const [prop, declA] of blockA.decls) {
        const declB = blockB.decls.get(prop);
        if (!declB) return false;
        if (declA.value !== declB.value || declA.important !== declB.important) return false;
      }
    }
    return true;
  };

  return {
    version: 'domflax-normalizer@1',
    normalizeDeclaration,
    normalizeValue,
    normalizeStyleMap,
    equals,
    inherited,
  };
}

/** The shared, process-wide normalizer instance reused by core / patterns / verify. */
export const normalizer: StyleNormalizer = createNormalizer();

/* ───────────────────────── superset helper (used by `computed()` matcher) ───────────────────────── */

/**
 * True when `full` contains every declaration of `partial` with an equal normalized value
 * (a per-condition, per-declaration superset test). Both maps are normalized first so the
 * comparison is meaning-based, not string-based. Empty `partial` ⇒ always `true`.
 */
export function isStyleSuperset(
  full: StyleMap,
  partial: StyleMap,
  norm: StyleNormalizer = normalizer,
): boolean {
  const nf = norm.normalizeStyleMap(full);
  const np = norm.normalizeStyleMap(partial);
  for (const [key, want] of np.blocks) {
    const have = nf.blocks.get(key) ?? nf.blocks.get(conditionKey(want.condition));
    if (!have) return false;
    for (const [prop, decl] of want.decls) {
      const got = have.decls.get(prop);
      if (!got || got.value !== decl.value) return false;
    }
  }
  return true;
}

/** Re-exported for callers that want to (de)construct keys without importing core directly. */
export { emptyStyleMap };
