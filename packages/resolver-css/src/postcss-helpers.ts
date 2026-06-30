import type { AtRule, Rule } from 'postcss';
import type { RawDecl } from './types';

/* ────────────────────────────────────────────────────────────────────────── *
 * postcss helpers
 * ────────────────────────────────────────────────────────────────────────── */

interface MediaContext {
  readonly media: string;
  /** True when the rule lives under an at-rule that is not a style context (keyframes/font-face). */
  readonly skip: boolean;
}

/** Walk a rule's at-rule ancestry, collecting `@media` params and detecting non-style contexts. */
export function mediaContext(rule: Rule): MediaContext {
  const parts: string[] = [];
  let skip = false;
  let parent = rule.parent;
  while (parent && parent.type === 'atrule') {
    const at = parent as AtRule;
    const name = at.name.toLowerCase();
    if (name === 'media') parts.unshift(at.params.trim().replace(/\s+/g, ' '));
    else if (name === 'keyframes' || name.endsWith('keyframes') || name === 'font-face') skip = true;
    parent = parent.parent;
  }
  return { media: parts.join(' and '), skip };
}

/** A rule's direct declarations, in source order, as raw `[prop, value, important]` triples. */
export function collectDecls(rule: Rule): RawDecl[] {
  const out: RawDecl[] = [];
  for (const node of rule.nodes) {
    if (node.type === 'decl') out.push([node.prop, node.value, node.important === true]);
  }
  return out;
}
