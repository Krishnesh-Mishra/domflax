/**
 * @domflax/resolver-tailwind — CSS serialization for `cssFor`.
 */

import type { TwGeneratedAtRule, TwGeneratedDecl, TwGeneratedRule, TwNode } from './types';

/** Serialize one engine-emitted node (rule / atrule / decl) into plain CSS text. */
export function serializeCssNode(node: TwNode): string {
  if (node.type === 'decl') {
    const d = node as TwGeneratedDecl;
    if (typeof d.value !== 'string') return '';
    return `${d.prop}:${d.value}${d.important === true ? ' !important' : ''}`;
  }
  if (node.type === 'rule') {
    const r = node as TwGeneratedRule;
    const body = (r.nodes ?? [])
      .map((c) => serializeCssNode(c))
      .filter((s) => s.length > 0)
      .join(';');
    return `${r.selector}{${body}}`;
  }
  if (node.type === 'atrule') {
    const a = node as TwGeneratedAtRule;
    const body = (a.nodes ?? [])
      .map((c) => serializeCssNode(c))
      .filter((s) => s.length > 0)
      .join('');
    return `@${a.name} ${a.params}{${body}}`;
  }
  return '';
}
