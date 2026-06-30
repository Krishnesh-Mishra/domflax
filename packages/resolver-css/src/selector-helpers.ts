import type selectorParser from 'postcss-selector-parser';
import { LEGACY_PSEUDO_ELEMENTS } from './constants';
import { sp } from './engine';

/* ────────────────────────────────────────────────────────────────────────── *
 * Selector helpers
 * ────────────────────────────────────────────────────────────────────────── */

export interface Compound {
  /** The combinator immediately to this compound's LEFT (`null` for the first compound). */
  readonly leftCombinator: string | null;
  readonly nodes: readonly selectorParser.Node[];
}

/** Split a selector's flat node list into compounds delimited by combinator nodes. */
export function splitCompounds(selector: selectorParser.Selector): Compound[] {
  const compounds: Compound[] = [];
  let current: selectorParser.Node[] = [];
  let leftCombinator: string | null = null;
  for (const node of selector.nodes) {
    if (sp!.isCombinator(node)) {
      compounds.push({ leftCombinator, nodes: current });
      current = [];
      leftCombinator = combinatorValue(node);
    } else {
      current.push(node);
    }
  }
  compounds.push({ leftCombinator, nodes: current });
  return compounds;
}

/** A combinator's normalized value — descendant combinators are a single space. */
function combinatorValue(node: selectorParser.Combinator): string {
  const v = node.value;
  return v.trim() === '' ? ' ' : v.trim();
}

/** The pseudo's lower-cased name including its leading colon(s), without any argument. */
export function pseudoName(node: selectorParser.Pseudo): string {
  return node.value.toLowerCase();
}

export function isPseudoElement(node: selectorParser.Pseudo): boolean {
  return sp!.isPseudoElement(node) || LEGACY_PSEUDO_ELEMENTS.has(pseudoName(node));
}

/** Canonicalize a pseudo-element to the modern double-colon form (e.g. `:before` → `::before`). */
export function normalizePseudoElement(node: selectorParser.Pseudo): string {
  const name = pseudoName(node);
  return name.startsWith('::') ? name : `::${name.replace(/^:/, '')}`;
}
