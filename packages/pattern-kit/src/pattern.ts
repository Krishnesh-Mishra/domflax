/**
 * @domflax/pattern-kit — `definePattern()`: THE declarative pattern-authoring surface.
 *
 * `definePattern(config)` is the single public way to author a rewrite pattern: definition AND its
 * tests are co-located in one call. It compiles down to the private lower-level
 * {@link import('./define').validatePattern}/{@link Pattern} contract (it never replaces the
 * engine). Authors describe the match as a plain DATA object and the rewrite as a named RECIPE; this
 * module maps each key to the existing matcher combinators and op-draft factories, auto-applies the
 * phase-appropriate safety guards (the full opacity-barrier + selector set for `flatten/*`; the
 * narrower class-rewrite-safety set for `compress/*`) so authors never hand-write them, and threads
 * `doc`/`test` through. Two escape hatches — a `match` predicate and a `rewrite` function — keep
 * exotic patterns (e.g. ones anchored on a parent fragment) expressible.
 *
 * The co-located {@link PatternTest} (`provider`/`cssFiles`/`cases`/`noMatch`/`custom`) is carried on
 * the compiled {@link AuthoredPattern} as `.test`, where the generic harness (`./testing`) reads it:
 * each `case` asserts `before → after`, each `noMatch` asserts the input is left unchanged, and the
 * optional `custom` hook runs arbitrary assertions against the built transform.
 *
 * `style` blocks in the declarative match (and in `childGains`/`mergeStyle` recipes) are PLAIN
 * objects (camelCase or kebab keys) auto-normalized into a superset StyleMap via the shared
 * normalizer — authors never import the normalizer or hand-build a StyleMap.
 *
 * `pattern` remains exported as a DEPRECATED alias of `definePattern` for backward compatibility.
 */

import type {
  Captures,
  ConditionKey,
  CssProperty,
  DeepReadonly,
  IRElement,
  IRNode,
  IRNodeId,
  MatchContext,
  MatchResult,
  NodeLike,
  NodeMeta,
  PassCategory,
  PassPhase,
  Pattern,
  PatternDoc,
  PreconditionSketch,
  RewriteFactory,
  RewriteOpDraft,
  SafetyLevel,
  StyleBlock,
  StyleDecl,
  StyleMap,
  StyleOrigin,
  StyleConflictPolicy,
} from '@domflax/core';
import { BASE_CONDITION, conditionKey } from '@domflax/core';

import {
  and,
  computed,
  hasDynamicChildren,
  hasDynamicClasses,
  hasEventHandlers,
  hasOwnVisualStyle,
  hasRef,
  hasSingleElementChild,
  isElement,
  not,
  opaque,
  targetedByCombinator,
  type Matcher,
} from './combinators';
import { validatePattern } from './define';
import { normalizer } from './normalize';

/* ───────────────────────── public config shapes ───────────────────────── */

/** A plain CSS style object: camelCase or kebab-case keys, string or number values. */
export type PlainStyle = Readonly<Record<string, string | number>>;

/**
 * Declarative match as DATA. Every key maps to one of the existing matcher combinators; an empty
 * object matches any element. Use the `match` FUNCTION escape hatch for anything not expressible
 * here (relational/ancestor/sibling shapes, parent-anchored patterns, …).
 */
export interface DeclarativeMatch {
  /** Restrict to a tag (case-insensitive). Omit to match any element. */
  readonly tag?: string;
  /** Computed style the node must be a SUPERSET of (plain object, auto-normalized). */
  readonly style?: PlainStyle;
  /** Require exactly one ELEMENT child. */
  readonly onlyChild?: 'element';
  /** Require the element to paint nothing of its own (no own visual style). */
  readonly paintsNothing?: boolean;
  /** Extra, hand-written predicate AND-ed into the declarative match. */
  readonly where?: Matcher | readonly Matcher[];
}

/** Escape hatch: a raw match predicate (no auto-guards are added). */
export type MatchFn = (node: NodeLike, ctx: MatchContext) => boolean;

/**
 * Flatten recipe: fold inherited styles onto the sole element child (default on), optionally merge
 * `childGains` onto it, then unwrap the node (id-preserving). Mirrors the flatten exemplars.
 */
export interface FlattenIntoRecipe {
  readonly flattenInto: 'child';
  /** Plain style merged onto the surviving child (source-wins) before unwrap. */
  readonly childGains?: PlainStyle;
  /** Fold inheritable declarations onto the child first. Default `true`. */
  readonly foldInherited?: boolean;
}

/** Compress recipe: rebuild the element's class StyleMap; return `null` to decline. */
export interface RewriteClassesRecipe {
  readonly rewriteClasses: (computed: StyleMap, ctx: MatchContext) => StyleMap | null;
  /** Keep opaque/selector-bound tokens verbatim. Default `true`. */
  readonly preserveOpaque?: boolean;
}

/** Compress recipe: drop fully-overridden class tokens (provenance is pruned automatically). */
export interface DropClassesRecipe {
  readonly dropClasses: (computed: StyleMap, ctx: MatchContext) => Iterable<string>;
  /** Keep opaque/selector-bound tokens verbatim. Default `true`. */
  readonly preserveOpaque?: boolean;
}

/** Merge a literal plain style onto the matched element. */
export interface MergeStyleRecipe {
  readonly mergeStyle: PlainStyle;
  readonly onConflict?: StyleConflictPolicy;
}

export type RewriteRecipe =
  | FlattenIntoRecipe
  | RewriteClassesRecipe
  | DropClassesRecipe
  | MergeStyleRecipe;

/** Escape hatch: a raw rewrite that returns op drafts (or `null`/`[]` for no-op). */
export type RewriteFn = (
  ctx: MatchContext,
  rw: RewriteFactory,
) => readonly RewriteOpDraft[] | null;

/** A single positive before→after assertion run through the pattern's built transform. */
export interface PatternTestCase {
  readonly name?: string;
  readonly before: string;
  readonly after: string;
}

/** Helpers handed to a {@link PatternTest.custom} hook (the built transform + expectation sugar). */
export interface TestHelpers {
  /** Run the pattern's transform on `code` (default filename `'X.tsx'`). */
  readonly transform: (code: string, filename?: string) => string;
  /** Assert `before` transforms to `after` (whitespace-normalized). */
  readonly expectTransforms: (before: string, after: string) => void;
  /** Assert `code` is left unchanged (whitespace-normalized). */
  readonly expectUnchanged: (code: string) => void;
}

/**
 * Co-located test spec for a pattern. The generic harness (`./testing`) builds a transform for the
 * declared `provider` (default `'tailwind'`; `'custom'` resolves the listed `cssFiles`), then runs
 * every `case` (`before → after`), every `noMatch` (left unchanged), and the optional `custom` hook.
 */
export interface PatternTest {
  /** Which style provider the harness builds the transform from. Default `'tailwind'`. */
  readonly provider?: 'tailwind' | 'custom';
  /** For `provider: 'custom'` — the project stylesheet paths backing the CSS resolver. */
  readonly cssFiles?: readonly string[];
  /** Positive before→after assertions. */
  readonly cases?: readonly PatternTestCase[];
  /** Inputs the pattern must leave UNCHANGED (barriers, non-matching shapes, safety reverts). */
  readonly noMatch?: readonly string[];
  /** Arbitrary extra assertions against the built transform. */
  readonly custom?: (h: TestHelpers) => void;
}

export interface PatternConfig {
  readonly name: string;
  readonly category: PassCategory;
  readonly safety: SafetyLevel;
  readonly priority?: number;
  readonly precondition?: PreconditionSketch;
  readonly doc?: PatternDoc;
  /** Co-located tests consumed by the generic harness (`./testing`). */
  readonly test?: PatternTest;
  /** Declarative match DATA, or a raw predicate escape hatch. Defaults to "any element". */
  readonly match?: DeclarativeMatch | MatchFn;
  /** A named rewrite recipe, or a raw op-draft factory escape hatch. */
  readonly rewrite: RewriteRecipe | RewriteFn;
}

/** A {@link Pattern} that also carries its co-located {@link PatternTest} for the test harness. */
export interface AuthoredPattern<C extends Captures = Captures> extends Pattern {
  readonly test?: PatternTest;
  evaluate(ctx: MatchContext, rw: RewriteFactory): MatchResult<C> | null;
}

/* ───────────────────────── plain-style → StyleMap ───────────────────────── */

function camelToKebab(key: string): string {
  if (key.startsWith('--')) return key; // custom property — leave verbatim
  return key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

/** Build a single-(base-)condition StyleMap from a plain style object via the shared normalizer. */
function plainToStyleMap(style: PlainStyle): StyleMap {
  const decls = new Map<CssProperty, StyleDecl>();
  for (const [rawKey, rawValue] of Object.entries(style)) {
    const prop = camelToKebab(rawKey);
    for (const decl of normalizer.normalizeDeclaration(prop, String(rawValue), false)) {
      decls.set(decl.property, decl);
    }
  }
  const block: StyleBlock = { condition: BASE_CONDITION, decls };
  return { blocks: new Map<ConditionKey, StyleBlock>([[conditionKey(BASE_CONDITION), block]]) };
}

/* ───────────────────────── local meta / selector matchers ───────────────────────── */

function asElement(node: NodeLike): DeepReadonly<IRElement> | null {
  const n = node as DeepReadonly<IRNode>;
  return n.kind === 'element' ? (n as DeepReadonly<IRElement>) : null;
}

function metaFlag(flag: keyof NodeMeta): Matcher {
  return (node) => Boolean(asElement(node)?.meta[flag]);
}

/** Element renders raw/`dangerouslySetInnerHTML` markup — a hard opacity barrier. */
const hasRawHtml: Matcher = metaFlag('hasDangerousHtml');

/**
 * Unwrapping/removing this node would change the combinator / structural-pseudo match-set of itself,
 * its child, or a former sibling. Empty `reparentImpact` ⇒ structurally safe to hoist.
 */
const affectsSelectorMatching: Matcher = (node, ctx) => {
  const el = asElement(node);
  if (!el) return false;
  return ctx.selectors.reparentImpact(el.id as unknown as IRNodeId).size > 0;
};

/**
 * The opacity-barrier + selector-safety guards every `flatten/*` pattern must carry. Auto-applied to
 * the declarative match so authors never hand-write them (the flatten exemplars spell them out).
 *
 * Flatten UNWRAPS the element (moving its children into a new parent and dropping its box), so every
 * opacity barrier matters: a ref, event handler, dynamic child, or raw HTML on the wrapper — or any
 * selector the reparent would disturb — makes the flatten unsafe.
 */
const FLATTEN_GUARDS: Matcher = and(
  not(hasRef),
  not(hasEventHandlers),
  not(hasDynamicChildren),
  not(hasRawHtml),
  not(targetedByCombinator),
  not(affectsSelectorMatching),
);

/**
 * The guards every `compress/*` pattern must carry. Compress ONLY ever rewrites the element's OWN
 * class tokens (e.g. `px-4 py-4 → p-4`) — it never touches the element's structure, children, or
 * identity. A dynamic `{expr}` child, a ref, an event handler, or `dangerouslySetInnerHTML` is
 * therefore wholly unaffected by a class-only change, so — unlike flatten — those opacity barriers
 * must NOT gate compress. Compress is gated ONLY on what actually makes a class rewrite unsafe:
 *   • a className we can't statically rewrite — a dynamic segment ({@link hasDynamicClasses}) or a
 *     wholly dynamic / spread-derived list ({@link opaque}); and
 *   • the selector-safety guard — a class a CSS combinator selector structurally depends on
 *     ({@link targetedByCombinator}) must not be dropped or rewritten.
 */
const COMPRESS_GUARDS: Matcher = and(
  not(hasDynamicClasses),
  not(opaque),
  not(targetedByCombinator),
);

/* ───────────────────────── match compilation ───────────────────────── */

/** The auto-applied guard set for a pattern's phase (compress vs flatten get different barriers). */
function autoGuardsFor(category: PassCategory): Matcher | null {
  switch (category.split('/', 1)[0] as PassPhase) {
    case 'flatten':
      return FLATTEN_GUARDS;
    case 'compress':
      return COMPRESS_GUARDS;
    default:
      return null;
  }
}

function compileDeclarativeMatch(m: DeclarativeMatch): Matcher {
  const parts: Matcher[] = [isElement(m.tag)];
  if (m.style) parts.push(computed(plainToStyleMap(m.style)));
  if (m.onlyChild === 'element') parts.push(hasSingleElementChild);
  if (m.paintsNothing) parts.push(not(hasOwnVisualStyle));
  if (m.where) {
    const extra = Array.isArray(m.where) ? (m.where as readonly Matcher[]) : [m.where as Matcher];
    for (const w of extra) parts.push(w);
  }
  return and(...parts);
}

function compileMatch(
  match: DeclarativeMatch | MatchFn | undefined,
  category: PassCategory,
): MatchFn {
  // Escape hatch: a raw predicate takes full control (no auto-guards).
  if (typeof match === 'function') return match;

  const declarative = compileDeclarativeMatch(match ?? {});
  const guards = autoGuardsFor(category);
  const guarded = guards ? and(declarative, guards) : declarative;
  return (node, ctx) => guarded(node, ctx);
}

/* ───────────────────────── rewrite compilation ───────────────────────── */

/** Clone `sm`, pruning every `shadowed` provenance entry that references a dropped class token. */
function pruneShadowed(sm: StyleMap, drop: ReadonlySet<string>): StyleMap {
  const blocks = new Map<ConditionKey, StyleBlock>();
  for (const [key, block] of sm.blocks) {
    const decls = new Map<CssProperty, StyleDecl>();
    for (const [prop, decl] of block.decls) {
      const filtered = (decl.shadowed ?? []).filter(
        (o) => !(o.kind === 'class' && drop.has(o.className)),
      );
      const rest: StyleDecl = { ...decl };
      delete (rest as { shadowed?: readonly StyleOrigin[] }).shadowed;
      const next: StyleDecl = filtered.length > 0 ? { ...rest, shadowed: filtered } : rest;
      decls.set(prop, next);
    }
    blocks.set(key, { condition: block.condition, decls });
  }
  return { blocks };
}

function compileFlattenInto(recipe: FlattenIntoRecipe): RewriteFn {
  const childGains = recipe.childGains ? plainToStyleMap(recipe.childGains) : null;
  const fold = recipe.foldInherited !== false;
  return (ctx, rw) => {
    const wrapper = ctx.node;
    const child = ctx.onlyElementChild();
    if (!child) return null;
    const ops: RewriteOpDraft[] = [];
    if (fold) ops.push(rw.foldInheritedStyles(wrapper, child, { conditions: 'all' }));
    if (childGains) ops.push(rw.mergeStyle(child, null, childGains, 'source-wins'));
    ops.push(rw.unwrap(wrapper));
    return ops;
  };
}

function compileRewrite(rewrite: RewriteRecipe | RewriteFn): RewriteFn {
  if (typeof rewrite === 'function') return rewrite;

  if ('flattenInto' in rewrite) return compileFlattenInto(rewrite);

  if ('rewriteClasses' in rewrite) {
    const preserveOpaque = rewrite.preserveOpaque ?? true;
    return (ctx, rw) => {
      const next = rewrite.rewriteClasses(ctx.computed(), ctx);
      if (!next) return null;
      return [rw.setClassList(ctx.node, next, preserveOpaque)];
    };
  }

  if ('dropClasses' in rewrite) {
    const preserveOpaque = rewrite.preserveOpaque ?? true;
    return (ctx, rw) => {
      const drop = new Set<string>(rewrite.dropClasses(ctx.computed(), ctx));
      if (drop.size === 0) return null;
      return [rw.setClassList(ctx.node, pruneShadowed(ctx.computed(), drop), preserveOpaque)];
    };
  }

  // MergeStyleRecipe
  const style = plainToStyleMap(rewrite.mergeStyle);
  const onConflict = rewrite.onConflict ?? 'abort';
  return (ctx, rw) => [rw.mergeStyle(ctx.node, null, style, onConflict)];
}

/* ───────────────────────── the public factory ───────────────────────── */

/**
 * THE declarative pattern-authoring function. Compile a {@link PatternConfig} (definition + co-located
 * {@link PatternTest}) into a validated {@link AuthoredPattern}: a normal {@link Pattern} (registerable
 * into any {@link import('@domflax/core').Pass}) that also exposes its `test` for the generic harness.
 */
export function definePattern(config: PatternConfig): AuthoredPattern {
  const matchFn = compileMatch(config.match, config.category);
  const rewriteFn = compileRewrite(config.rewrite);

  const spec: AuthoredPattern = {
    name: config.name,
    category: config.category,
    safety: config.safety,
    priority: config.priority,
    precondition: config.precondition,
    doc: config.doc,
    test: config.test,
    evaluate(ctx: MatchContext, rw: RewriteFactory): MatchResult | null {
      if (!matchFn(ctx.node as unknown as NodeLike, ctx)) return null;
      const ops = rewriteFn(ctx, rw);
      if (!ops || ops.length === 0) return null;
      return { ops };
    },
  };

  // `validatePattern` validates + freezes; the spread preserves `test` at runtime.
  return validatePattern(spec) as AuthoredPattern;
}

/**
 * @deprecated Use {@link definePattern}. Retained as a thin alias for backward compatibility.
 */
export const pattern = definePattern;
