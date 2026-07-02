/**
 * @domflax/resolver-tailwind — ARBITRARY-VALUE candidate synthesis.
 *
 * The forward engine happily RESOLVES arbitrary-value tokens (`h-[40px]`, `p-[7px]` — v3 JIT and the
 * v4 design system both), but the reverse side historically searched only the ENUMERABLE class list,
 * so a target like `width:40px; height:40px` had no reachable cover and `h-[40px] w-[40px]` could
 * never fold to `size-[40px]`. This module closes that gap: for ONE-PROPERTY FAMILIES with a known
 * stem mapping it PROPOSES synthesized `stem-[value]` candidates for the exact values a target block
 * asks for.
 *
 * A proposal is only ever a CANDIDATE: the cover builder VALIDATES each one by ROUND-TRIPPING it
 * through the real engine (generate → extract → normalize) and admits it only when the resolved
 * tuples match the proposal's intended declarations EXACTLY. A synthesized token the engine rejects,
 * resolves differently (negative padding, unparsable value, underscore/space ambiguity), or resolves
 * under the wrong condition is silently discarded — nothing unvalidated ever reaches the cover.
 *
 * Cost is inherent: the DP minimizes total token length, so an enumerated `p-4` (when the value
 * matches the theme scale exactly) always beats the longer `p-[1rem]`.
 */

import type { CssProperty, StyleDecl } from '@domflax/core';

/** One synthesized candidate: the token plus the exact longhand pairs it MUST resolve to. */
export interface SynthProposal {
  readonly token: string;
  /** `[property, canonicalValue]` pairs (all `important:false`) the round-trip must reproduce. */
  readonly decls: ReadonlyArray<readonly [string, string]>;
}

/** One family group: a stem that sets EXACTLY these longhands (all to the same single value). */
interface SynthGroup {
  readonly stem: string;
  readonly props: readonly string[];
}

const PADDING = ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'] as const;
const MARGIN = ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'] as const;
const RADIUS = [
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
] as const;

/**
 * The one-property families with a known stem mapping (padding/margin sides, width/height/size,
 * gap axes, inset sides, border-radius, the four offsets). Order is irrelevant — the exact-cover DP
 * picks by cost — but broader groups are listed first for readability.
 */
const SYNTH_GROUPS: readonly SynthGroup[] = [
  // padding
  { stem: 'p', props: PADDING },
  { stem: 'px', props: ['padding-left', 'padding-right'] },
  { stem: 'py', props: ['padding-top', 'padding-bottom'] },
  { stem: 'pt', props: ['padding-top'] },
  { stem: 'pr', props: ['padding-right'] },
  { stem: 'pb', props: ['padding-bottom'] },
  { stem: 'pl', props: ['padding-left'] },
  // margin
  { stem: 'm', props: MARGIN },
  { stem: 'mx', props: ['margin-left', 'margin-right'] },
  { stem: 'my', props: ['margin-top', 'margin-bottom'] },
  { stem: 'mt', props: ['margin-top'] },
  { stem: 'mr', props: ['margin-right'] },
  { stem: 'mb', props: ['margin-bottom'] },
  { stem: 'ml', props: ['margin-left'] },
  // sizing (width + height fold to `size-[..]` when equal)
  { stem: 'size', props: ['width', 'height'] },
  { stem: 'w', props: ['width'] },
  { stem: 'h', props: ['height'] },
  // gap
  { stem: 'gap', props: ['row-gap', 'column-gap'] },
  { stem: 'gap-x', props: ['column-gap'] },
  { stem: 'gap-y', props: ['row-gap'] },
  // inset / offsets
  { stem: 'inset', props: ['top', 'right', 'bottom', 'left'] },
  { stem: 'inset-x', props: ['left', 'right'] },
  { stem: 'inset-y', props: ['top', 'bottom'] },
  { stem: 'top', props: ['top'] },
  { stem: 'right', props: ['right'] },
  { stem: 'bottom', props: ['bottom'] },
  { stem: 'left', props: ['left'] },
  // border-radius (all four corners equal → `rounded-[..]`)
  { stem: 'rounded', props: RADIUS },
];

/**
 * Escape a canonical CSS value into Tailwind's arbitrary-value syntax: whitespace becomes `_`.
 * Values the syntax cannot carry unambiguously (brackets/braces/quotes/semicolons — or a literal
 * underscore, which the engine would decode back into a space) return `null` (no proposal).
 */
export function arbitraryValue(value: string): string | null {
  if (/[[\]{}'"`;_]/.test(value)) return null;
  const v = value.replace(/\s+/g, '_');
  return v.length > 0 ? v : null;
}

/**
 * Propose synthesized `stem-[value]` candidates for one condition block's declarations. A group
 * fires only when EVERY one of its longhands is present, non-`!important`, and carries the SAME
 * canonical value. All proposals are unvalidated candidates — the cover builder round-trips each
 * through the real engine before admitting it.
 */
export function synthesizeProposals(
  decls: ReadonlyMap<CssProperty, StyleDecl>,
): SynthProposal[] {
  const out: SynthProposal[] = [];
  for (const group of SYNTH_GROUPS) {
    let value: string | null = null;
    let ok = true;
    for (const prop of group.props) {
      const d = decls.get(prop as CssProperty);
      if (!d || d.important) {
        ok = false;
        break;
      }
      const v = String(d.value);
      if (value === null) value = v;
      else if (value !== v) {
        ok = false;
        break;
      }
    }
    if (!ok || value === null) continue;
    const arb = arbitraryValue(value);
    if (arb === null) continue;
    out.push({
      token: `${group.stem}-[${arb}]`,
      decls: group.props.map((p) => [p, value!] as const),
    });
  }
  return out;
}
