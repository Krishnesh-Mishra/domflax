/**
 * @domflax/resolver-tailwind — rule extraction (engine nodes → usable blocks).
 */

import type { OpaqueToken, StyleCondition } from '@domflax/core';

import { makeCondition, parseSelector } from './selector';
import type { TwGeneratedAtRule, TwGeneratedDecl, TwGeneratedRule, TwNode } from './types';

export interface ExtractedBlock {
  readonly condition: StyleCondition;
  readonly decls: ReadonlyArray<readonly [string, string, boolean]>;
}

export interface ExtractedToken {
  /** Usable (BASE + supported-variant) blocks. */
  readonly blocks: readonly ExtractedBlock[];
  /** True if the engine emitted at least one rule for the token (even an opaque one). */
  readonly produced: boolean;
  /** Set when the token only resolves via combinator / unsupported at-rule selectors. */
  readonly opaque?: OpaqueToken;
}

/** Collect every leaf `rule` node together with the `@media` stack that wraps it. */
function collectRules(
  node: TwNode,
  mediaStack: readonly string[],
  inUnsupportedAtRule: boolean,
  out: Array<{ rule: TwGeneratedRule; media: readonly string[]; unsupported: boolean }>,
): void {
  if (node.type === 'rule') {
    out.push({ rule: node as TwGeneratedRule, media: mediaStack, unsupported: inUnsupportedAtRule });
    return;
  }
  if (node.type === 'atrule') {
    const at = node as TwGeneratedAtRule;
    const children = at.nodes ?? [];
    if (at.name === 'media') {
      const nextStack = at.params ? [...mediaStack, at.params] : mediaStack;
      for (const child of children) collectRules(child, nextStack, inUnsupportedAtRule, out);
    } else {
      // @supports / @container / etc. — recurse but flag as unsupported (⇒ opaque).
      for (const child of children) collectRules(child, mediaStack, true, out);
    }
  }
}

/** Extract usable blocks + opacity info for a single candidate token from its generated nodes. */
export function extractToken(token: string, nodes: readonly TwNode[]): ExtractedToken {
  if (nodes.length === 0) return { blocks: [], produced: false };

  const leaves: Array<{ rule: TwGeneratedRule; media: readonly string[]; unsupported: boolean }> = [];
  for (const node of nodes) collectRules(node, [], false, leaves);

  const blocks: ExtractedBlock[] = [];
  let sawComplex = false;

  for (const { rule, media, unsupported } of leaves) {
    const parsed = parseSelector(rule.selector);
    if (parsed.kind === 'complex' || unsupported) {
      sawComplex = true;
      continue;
    }
    const decls: Array<readonly [string, string, boolean]> = [];
    for (const child of rule.nodes ?? []) {
      if (child.type !== 'decl') continue; // skip @defaults markers, comments, nested rules
      const d = child as TwGeneratedDecl;
      if (typeof d.value !== 'string') continue;
      decls.push([d.prop, d.value, d.important === true]);
    }
    if (decls.length === 0) continue;
    const mediaQuery = media.join(' and ');
    blocks.push({ condition: makeCondition(mediaQuery, parsed.states, parsed.pseudoElement), decls });
  }

  const opaque: OpaqueToken | undefined =
    sawComplex && blocks.length === 0
      ? { token, reason: 'combinator-variant', detail: 'utility targets descendants/siblings, not its own box' }
      : undefined;

  return { blocks, produced: true, opaque };
}
