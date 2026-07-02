/**
 * @domflax/frontend-vue tests — shared pipeline harness + stub resolvers.
 *
 * Mirrors the real pipeline shape used by the HTML frontend suite: parse → runPasses(provably-safe)
 * → reverse-emit → surgical print. Resolvers are self-contained STUBS (no Tailwind engine) so the
 * suite exercises the frontend/backend contract in isolation:
 *
 *   • `resolvedEmptyResolver` — every token is KNOWN but paints nothing ⇒ genuinely inert,
 *     flatten-eligible wrappers.
 *   • `paddingResolver`      — a 3-token utility system (`px-4` / `py-4` / `p-4`, all `1rem`) with a
 *     reverse `emit`, so the compress engine can collapse `px-4 py-4` → `p-4`.
 */

import type {
  ApplyContext,
  CssProperty,
  IRDocument,
  Pass,
  PassCategory,
  PassPhase,
  Pattern,
  ResolveInput,
  ResolveResult,
  SafetyLevel,
  SelectorUsage,
  StyleDecl,
  StyleMap,
  StyleResolver,
} from '@domflax/core';
import {
  BASE_CONDITION,
  BASE_CONDITION_KEY,
  buildSelectorIndex,
  createSyntheticSink,
  emptyStyleMap,
  runPasses,
  syncClassesFromComputed,
} from '@domflax/core';
import { normalizer } from '@domflax/pattern-kit';
import { builtinPatterns } from '@domflax/patterns';

import { createVueBackend, createVueFrontend } from '../src/index';

/* ───────────────────────── pipeline harness ───────────────────────── */

/** Group the flat pattern list into one {@link Pass} per {@link PassPhase} (derived from category). */
function buildPasses(patterns: readonly Pattern[]): Pass[] {
  const byPhase = new Map<PassPhase, Pattern[]>();
  for (const p of patterns) {
    const phase = (p.category.split('/', 1)[0] ?? 'flatten') as PassPhase;
    (byPhase.get(phase) ?? byPhase.set(phase, []).get(phase)!).push(p);
  }
  return [...byPhase].map(([phase, pats]) => ({
    phase,
    category: `${phase}/builtin` as PassCategory,
    patterns: pats,
  }));
}

export function parseVue(code: string, resolver: StyleResolver): IRDocument {
  const { doc } = createVueFrontend().parse(code, {
    id: 'App.vue',
    kind: 'unknown',
    resolver,
    normalizer,
    config: {},
    onDiagnostic: () => {},
  });
  return doc;
}

/** Run the full pipeline: parse → runPasses(provably-safe) → reverse-emit → surgical print. */
export function optimizeVue(code: string, resolver: StyleResolver, safety: SafetyLevel = 2): string {
  const doc = parseVue(code, resolver);
  const ctx: ApplyContext = {
    doc,
    safetyCeiling: safety,
    normalizer,
    selectors: buildSelectorIndex(doc, resolver),
    resolver,
    gate: 'provably-safe',
  };
  const { doc: optimized } = runPasses(doc, buildPasses(builtinPatterns), ctx);
  syncClassesFromComputed(optimized, resolver, normalizer);
  return createVueBackend().print(
    optimized,
    { moduleId: 'App.vue', ops: [], provenance: new Map() },
    { normalizer, resolver, sink: createSyntheticSink(), eol: '\n', onDiagnostic: () => {} },
  ).code;
}

/* ───────────────────────── stub resolvers ───────────────────────── */

const NOT_DROPPABLE: SelectorUsage = {
  asSubject: false,
  asAncestor: false,
  asCompound: false,
  asSibling: false,
  asHasArgument: false,
  asStructural: false,
  droppable: false,
};

function baseResolver(over: Partial<StyleResolver>): StyleResolver {
  return {
    id: 'stub',
    provider: 'stub@0.0.0',
    fingerprint: 'stub',
    owns: () => false,
    resolve: () => ({ styles: emptyStyleMap(), resolved: [], unknown: [], opaque: [], warnings: [] }),
    emit: () => ({ classes: [], exact: true, warnings: [] }),
    selectorUsage: () => NOT_DROPPABLE,
    ...over,
  };
}

/** Every token is KNOWN (resolved) but paints nothing — genuinely inert, flatten-eligible wrappers. */
export function resolvedEmptyResolver(): StyleResolver {
  return baseResolver({
    resolve: (input: ResolveInput): ResolveResult => ({
      styles: emptyStyleMap(),
      resolved: [...input.classes],
      unknown: [],
      opaque: [],
      warnings: [],
    }),
    selectorUsage: () => ({ ...NOT_DROPPABLE, droppable: true }),
  });
}

/* ----- padding utility stub (compressible: px-4 py-4 → p-4) ----- */

const REM = '1rem';
const SIDES: Record<string, readonly string[]> = {
  'p-4': ['top', 'right', 'bottom', 'left'],
  'px-4': ['left', 'right'],
  'py-4': ['top', 'bottom'],
};

function paddingStyleMap(sides: Iterable<string>): StyleMap {
  const decls = new Map<CssProperty, StyleDecl>();
  for (const side of sides) {
    for (const d of normalizer.normalizeDeclaration(`padding-${side}`, REM, false)) {
      decls.set(d.property, d);
    }
  }
  if (decls.size === 0) return emptyStyleMap();
  return normalizer.normalizeStyleMap({
    blocks: new Map([[BASE_CONDITION_KEY, { condition: BASE_CONDITION, decls }]]),
  });
}

/**
 * A tiny utility resolver: `px-4` / `py-4` / `p-4` set the matching `padding-*` sides to `1rem`;
 * `emit` reproduces the minimal token set for a pure-padding StyleMap (else emits nothing).
 */
export function paddingResolver(): StyleResolver {
  return baseResolver({
    owns: (t: string) => t in SIDES,
    resolve: (input: ResolveInput): ResolveResult => {
      const sides = new Set<string>();
      const resolved: string[] = [];
      const unknown: string[] = [];
      for (const c of input.classes) {
        const s = SIDES[c];
        if (!s) {
          unknown.push(c);
          continue;
        }
        resolved.push(c);
        for (const side of s) sides.add(side);
      }
      return { styles: paddingStyleMap(sides), resolved, unknown, opaque: [], warnings: [] };
    },
    emit: (styles: StyleMap) => {
      const none = { classes: [] as string[], exact: true, warnings: [] };
      if (styles.blocks.size === 0) return none;
      const block = styles.blocks.get(BASE_CONDITION_KEY);
      if (!block || styles.blocks.size !== 1) return { ...none, exact: false };
      const has = (side: string): boolean =>
        block.decls.get(`padding-${side}` as CssProperty)?.value === REM;
      const t = has('top');
      const r = has('right');
      const b = has('bottom');
      const l = has('left');
      const count = [t, r, b, l].filter(Boolean).length;
      if (block.decls.size !== count || count === 0) return { ...none, exact: false };
      if (t && r && b && l) return { classes: ['p-4'], exact: true, warnings: [] };
      const classes: string[] = [];
      if (l && r) classes.push('px-4');
      if (t && b) classes.push('py-4');
      // Only exact when the emitted axes cover every present side.
      const covered = (l && r ? 2 : 0) + (t && b ? 2 : 0);
      if (covered !== count) return { ...none, exact: false };
      return { classes, exact: true, warnings: [] };
    },
    selectorUsage: () => ({ ...NOT_DROPPABLE, droppable: true }),
  });
}
