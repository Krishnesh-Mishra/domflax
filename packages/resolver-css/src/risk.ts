/**
 * @domflax/resolver-css — SELECTOR-BOUND RISK tracking for the inline-style ⇄ class converter.
 *
 * The converter demotes an inline `style` declaration (which beats EVERY selector) to class
 * specificity, so it must know whether ANY project rule OTHER than the element's own fully-modelled
 * single-class rules could set that property on the element. The resolver's forward index only
 * models bare single-class subjects; everything else — a bare-tag rule (`div { padding: 4px }`), a
 * universal rule, a combinator subject (`.list > .item`), a compound (`.a.b`), an id/attribute
 * subject, structural pseudos — is INVISIBLE to `resolve()` and therefore a conversion hazard.
 *
 * This module records one {@link RiskRule} per such selector (its SUBJECT compound's shape + the
 * normalized longhand properties the rule sets) and answers {@link StyleResolver.competesWith}.
 * Matching is CONSERVATIVE by design: a compound `div.card` matches on tag OR class (a superset of
 * its real match-set), and a subject we cannot characterize (id/attribute/pseudo-only/nesting)
 * matches every element. A `true` answer only ever SUPPRESSES a conversion — never causes one.
 */

import type { CompetesInput } from '@domflax/core';
import { normalizer } from '@domflax/pattern-kit';
import type selectorParser from 'postcss-selector-parser';

import type { SelectorParserApi } from './engine';
import type { Compound } from './selector-helpers';
import type { RawDecl } from './types';

/** One non-fully-modelled rule: its subject-compound shape + the longhand properties it sets. */
export interface RiskRule {
  /** Class names in the subject compound (`.a.b` → both) — matches when the element has ANY. */
  readonly classes: readonly string[];
  /** Tag names in the subject compound, lower-cased — matches on tag equality. */
  readonly tags: readonly string[];
  /** Subject matches every element (`*`, or a subject with no concrete simple selector we track). */
  readonly universal: boolean;
  /** Normalized longhand properties the rule sets. */
  readonly properties: ReadonlySet<string>;
}

/**
 * Build the {@link RiskRule} for a selector's SUBJECT compound (the last compound), or `null` when
 * the rule sets no declarations. The caller only invokes this for selectors that are NOT fully
 * modelled by the forward index.
 */
export function buildRiskRule(
  sp: SelectorParserApi,
  compounds: readonly Compound[],
  decls: readonly RawDecl[],
): RiskRule | null {
  if (decls.length === 0) return null;
  const subject = compounds[compounds.length - 1];
  if (!subject) return null;

  const classes: string[] = [];
  const tags: string[] = [];
  let universal = false;
  let untrackable = false;
  for (const n of subject.nodes) {
    if (sp.isClassName(n)) classes.push((n as selectorParser.ClassName).value);
    else if (sp.isTag(n)) tags.push((n as selectorParser.Tag).value.toLowerCase());
    else if (sp.isUniversal(n)) universal = true;
    else if (sp.isIdentifier(n) || sp.isAttribute(n) || sp.isNesting(n)) untrackable = true;
  }
  // A subject with no class and no tag (`*`, `:hover`, `[data-x]`, `#id`, …) must match everything.
  if (untrackable || (classes.length === 0 && tags.length === 0)) universal = true;

  const properties = new Set<string>();
  for (const [prop, value, important] of decls) {
    for (const d of normalizer.normalizeDeclaration(prop, value, important)) {
      properties.add(String(d.property));
    }
  }
  if (properties.size === 0) return null;
  return { classes, tags, universal, properties };
}

/** Conservative {@link StyleResolver.competesWith} answer over the collected risk rules. */
export function riskCompetes(rules: readonly RiskRule[], input: CompetesInput): boolean {
  const property = String(input.property);
  const tag = input.tagName.toLowerCase();
  const classSet = new Set(input.classes);
  for (const rule of rules) {
    if (!rule.properties.has(property)) continue;
    if (rule.universal) return true;
    if (rule.tags.includes(tag)) return true;
    if (rule.classes.some((c) => classSet.has(c))) return true;
  }
  return false;
}
