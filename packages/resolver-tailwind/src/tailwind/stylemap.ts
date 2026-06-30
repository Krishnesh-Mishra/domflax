/**
 * @domflax/resolver-tailwind — StyleMap assembly + provenance helpers.
 */

import type {
  CssProperty,
  StyleBlock,
  StyleCondition,
  StyleDecl,
  StyleMap,
  StyleOrigin,
} from '@domflax/core';
import { conditionKey, emptyStyleMap } from '@domflax/core';
import { normalizer } from '@domflax/pattern-kit';

export function buildStyleMap(
  blockMaps: Map<string, { condition: StyleCondition; decls: Map<CssProperty, StyleDecl> }>,
): StyleMap {
  if (blockMaps.size === 0) return emptyStyleMap();
  const blocks = new Map<ReturnType<typeof conditionKey>, StyleBlock>();
  for (const { condition, decls } of blockMaps.values()) {
    if (decls.size === 0) continue;
    blocks.set(conditionKey(condition), { condition, decls });
  }
  if (blocks.size === 0) return emptyStyleMap();
  return normalizer.normalizeStyleMap({ blocks });
}

/**
 * The shadow chain a newly-winning declaration inherits when it overrides `prev` on the same
 * property: everything `prev` already shadowed, plus `prev`'s own origin (now shadowed too). Deduped
 * by class name and restricted to class origins (the only kind `dedupe-classes` acts on).
 */
export function shadowedBy(prev: StyleDecl): readonly StyleOrigin[] | undefined {
  const out: StyleOrigin[] = [];
  const seen = new Set<string>();
  const add = (o: StyleOrigin | undefined): void => {
    if (!o || o.kind !== 'class' || seen.has(o.className)) return;
    seen.add(o.className);
    out.push(o);
  };
  for (const o of prev.shadowed ?? []) add(o);
  add(prev.origin);
  return out.length > 0 ? out : undefined;
}
