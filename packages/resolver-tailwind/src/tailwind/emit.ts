/**
 * @domflax/resolver-tailwind — emit-side shorthand expansion + residual synthesis.
 */

import type {
  CssProperty,
  EmitContext,
  StyleBlock,
  StyleDecl,
  StyleMap,
  SyntheticClass,
} from '@domflax/core';
import { BASE_CONDITION, conditionKey } from '@domflax/core';
import { normalizer } from '@domflax/pattern-kit';

import { fnv1a } from './fingerprint';

/**
 * Expand a single computed declaration into the canonical LONGHAND `[property, value]` pairs the
 * reverse index is keyed on. The shared normalizer already expands the physical box shorthands
 * (`padding`/`margin`/`inset`/`border-*`); we additionally expand the few logical shorthands the
 * compress passes synthesize that the normalizer leaves intact (`size`, `inset-block`,
 * `inset-inline`). Values are re-canonicalized via the normalizer so they match the index exactly.
 */
export function expandForEmit(
  norm: { normalizeDeclaration: typeof normalizer.normalizeDeclaration },
  prop: string,
  value: string,
  important: boolean,
): Array<readonly [CssProperty, string]> {
  const pairsFor = (p: string, v: string): Array<readonly [CssProperty, string]> =>
    norm.normalizeDeclaration(p, v, important).map((d) => [d.property, String(d.value)] as const);

  if (prop === 'size') {
    return [...pairsFor('width', value), ...pairsFor('height', value)];
  }
  if (prop === 'inset-block' || prop === 'inset-inline') {
    const parts = value.split(/\s+/).filter((s) => s.length > 0);
    const a = parts[0] ?? value;
    const b = parts[1] ?? a;
    const sides = prop === 'inset-block' ? (['top', 'bottom'] as const) : (['left', 'right'] as const);
    return [...pairsFor(sides[0], a), ...pairsFor(sides[1], b)];
  }
  return pairsFor(prop, value);
}

/** Build a residual {@link SyntheticClass} for declarations no utility covered; `null` on failure. */
export function synthesizeResidual(
  remaining: ReadonlyMap<CssProperty, string>,
  ctx: EmitContext,
): SyntheticClass | undefined {
  if (remaining.size === 0) return undefined;
  const norm = ctx.normalizer ?? normalizer;
  const decls = new Map<CssProperty, StyleDecl>();
  for (const [prop, value] of remaining) {
    for (const decl of norm.normalizeDeclaration(String(prop), value, false)) {
      decls.set(decl.property, decl);
    }
  }
  const block: StyleBlock = { condition: BASE_CONDITION, decls };
  const styleMap: StyleMap = { blocks: new Map([[conditionKey(BASE_CONDITION), block]]) };
  const css = [...remaining].map(([p, v]) => `${p}:${v}`).join(';');
  const className = `df-${fnv1a(css)}`;
  const synthetic: SyntheticClass = { className, decls: styleMap, css: `.${className}{${css}}` };
  try {
    ctx.sink.register(synthetic);
  } catch {
    /* a sink that rejects registration must not break emit */
  }
  return synthetic;
}
