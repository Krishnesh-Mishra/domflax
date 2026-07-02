/**
 * @domflax/frontend-jsx — STATIC `style={{…}}` attribute lowering.
 *
 * A JSX style attribute whose value is an object literal of ONLY literal values (string / numeric,
 * non-computed keys) is provably static, so it can be lowered into {@link InlineStyle} — verbatim
 * per-property source slices plus their normalized longhand expansion — for the core inline-style ⇄
 * class converter. ANY dynamic shape (spread, computed key, identifier/call/template value,
 * conditional) returns `null` and the whole attribute is left untouched, exactly as before.
 *
 * Numeric values follow React's serialization: numbers get `px` appended unless the property is in
 * React's unitless set (`zIndex`, `opacity`, `flexGrow`, `lineHeight`, …).
 */

import type { JSXAttribute, Node as BabelNode } from '@babel/types';

import type { InlineStyle, InlineStyleRawDecl, SourceSpan, StyleNormalizer } from '@domflax/core';
import { inlineDeclMap } from '@domflax/core';

/** React's unitless style properties, in the KEBAB-CASE form the normalizer sees. */
const UNITLESS = new Set([
  'animation-iteration-count',
  'aspect-ratio',
  'border-image-outset',
  'border-image-slice',
  'border-image-width',
  'box-flex',
  'box-flex-group',
  'box-ordinal-group',
  'column-count',
  'columns',
  'flex',
  'flex-grow',
  'flex-shrink',
  'font-weight',
  'grid-area',
  'grid-column',
  'grid-column-end',
  'grid-column-start',
  'grid-row',
  'grid-row-end',
  'grid-row-start',
  'line-clamp',
  'line-height',
  'opacity',
  'order',
  'orphans',
  'tab-size',
  'widows',
  'z-index',
  'zoom',
  // SVG
  'fill-opacity',
  'flood-opacity',
  'stop-opacity',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-miterlimit',
  'stroke-opacity',
  'stroke-width',
]);

/** `paddingTop` → `padding-top`; `WebkitBoxOrient` → `-webkit-box-orient`; `--x` stays verbatim. */
function camelToKebab(key: string): string {
  if (key.startsWith('--')) return key;
  return key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

/** React's numeric serialization: `px`-suffixed unless the property is unitless. */
function numericCssValue(cssProp: string, n: number): string {
  if (!Number.isFinite(n)) return '';
  return UNITLESS.has(cssProp) ? String(n) : `${n}px`;
}

export interface StyleAttrHelpers {
  readonly spanOf: (node: BabelNode) => SourceSpan | null;
  readonly sliceOf: (node: BabelNode) => string;
  readonly normalizer: StyleNormalizer;
}

/**
 * Lower a JSX `style` attribute into a static {@link InlineStyle}, or `null` when ANY part of it is
 * dynamic / unrepresentable (the conservative default — attribute untouched). The returned span is
 * the WHOLE attribute (`style={{…}}`), which is what the backend splices/removes.
 */
export function parseJsxStyleAttr(attr: JSXAttribute, h: StyleAttrHelpers): InlineStyle | null {
  const v = attr.value;
  if (!v || v.type !== 'JSXExpressionContainer') return null;
  const obj = v.expression;
  if (obj.type !== 'ObjectExpression') return null;
  const attrSpan = h.spanOf(attr);
  if (!attrSpan) return null;

  const raws: InlineStyleRawDecl[] = [];
  for (const prop of obj.properties) {
    if (prop.type !== 'ObjectProperty' || prop.computed) return null;
    let key: string;
    if (prop.key.type === 'Identifier') key = prop.key.name;
    else if (prop.key.type === 'StringLiteral') key = prop.key.value;
    else return null;
    const cssProp = camelToKebab(key);

    const val = prop.value;
    let cssValue: string;
    if (val.type === 'StringLiteral') cssValue = val.value;
    else if (val.type === 'NumericLiteral') cssValue = numericCssValue(cssProp, val.value);
    else if (
      val.type === 'UnaryExpression' &&
      val.operator === '-' &&
      val.argument.type === 'NumericLiteral'
    ) {
      cssValue = numericCssValue(cssProp, -val.argument.value);
    } else return null;

    if (cssValue.trim().length === 0) return null;
    // React ignores `!important` in style objects — a value carrying it is not representable.
    const important = /!\s*important/i.test(cssValue);
    if (important) return null;

    const decls = h.normalizer.normalizeDeclaration(cssProp, cssValue, false);
    if (decls.length === 0) return null;
    raws.push({ text: h.sliceOf(prop), decls, important: false });
  }
  if (raws.length === 0) return null;

  const declMap = inlineDeclMap(raws);
  if (!declMap) return null; // duplicated longhand ⇒ order-dependent ⇒ untouched

  return { decls: declMap, dynamic: null, span: attrSpan, raw: raws };
}
