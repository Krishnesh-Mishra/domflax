/**
 * @domflax/pattern-kit — `pattern()`: a low-boilerplate, declarative authoring surface.
 *
 * `pattern(config)` is pure authoring SUGAR: it compiles down to the existing
 * {@link definePattern}/{@link Pattern} contract (it never replaces the engine). Authors describe
 * the match as a plain DATA object and the rewrite as a named RECIPE; this module maps each key to
 * the existing matcher combinators and op-draft factories, auto-applies the opacity-barrier and
 * selector-safety guards that every `flatten/*` pattern must carry, and threads `doc`/`examples`
 * through. Two escape hatches — a `match` predicate and a `rewrite` function — keep exotic patterns
 * (e.g. ones anchored on a parent fragment) expressible.
 *
 * `style` blocks in the declarative match (and in `childGains`/`mergeStyle` recipes) are PLAIN
 * objects (camelCase or kebab keys) auto-normalized into a superset StyleMap via the shared
 * normalizer — authors never import the normalizer or hand-build a StyleMap.
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
  hasEventHandlers,
  hasOwnVisualStyle,
  hasRef,
  hasSingleElementChild,
  isElement,
  not,
  targetedByCombinator,
  type Matcher,
} from './combinators';
import { definePattern } from './define';
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

/** A before/after positive example, or a no-match (left-unchanged) example. */
export type Example =
  | { readonly before: string; readonly after: string }
  | { readonly name?: string; readonly noMatch: string };

export interface PatternConfig {
  readonly name: string;
  readonly category: PassCategory;
  readonly safety: SafetyLevel;
  readonly priority?: number;
  readonly precondition?: PreconditionSketch;
  readonly doc?: PatternDoc;
  /** Optional worked examples consumed by the auto-test harness (`./testing`). */
  readonly examples?: readonly Example[];
  /** Declarative match DATA, or a raw predicate escape hatch. Defaults to "any element". */
  readonly match?: DeclarativeMatch | MatchFn;
  /** A named rewrite recipe, or a raw op-draft factory escape hatch. */
  readonly rewrite: RewriteRecipe | RewriteFn;
}

/** A {@link Pattern} that also carries its authored {@link Example}s for the test harness. */
export interface AuthoredPattern<C extends Captures = Captures> extends Pattern {
  readonly examples?: readonly Example[];
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
 */
const FLATTEN_GUARDS: Matcher = and(
  not(hasRef),
  not(hasEventHandlers),
  not(hasDynamicChildren),
  not(hasRawHtml),
  not(targetedByCombinator),
  not(affectsSelectorMatching),
);

/* ───────────────────────── match compilation ───────────────────────── */

function isFlattenCategory(category: PassCategory): boolean {
  return (category.split('/', 1)[0] as PassPhase) === 'flatten';
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
  const guarded = isFlattenCategory(category) ? and(declarative, FLATTEN_GUARDS) : declarative;
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
 * Compile a declarative {@link PatternConfig} into a validated {@link AuthoredPattern}. The result
 * is a normal {@link Pattern} (registerable into any {@link import('@domflax/core').Pass}) that also
 * exposes its `examples` for the auto-test harness.
 */
export function pattern(config: PatternConfig): AuthoredPattern {
  const matchFn = compileMatch(config.match, config.category);
  const rewriteFn = compileRewrite(config.rewrite);

  const spec: AuthoredPattern = {
    name: config.name,
    category: config.category,
    safety: config.safety,
    priority: config.priority,
    precondition: config.precondition,
    doc: config.doc,
    examples: config.examples,
    evaluate(ctx: MatchContext, rw: RewriteFactory): MatchResult | null {
      if (!matchFn(ctx.node as unknown as NodeLike, ctx)) return null;
      const ops = rewriteFn(ctx, rw);
      if (!ops || ops.length === 0) return null;
      return { ops };
    },
  };

  // `definePattern` validates + freezes; the spread preserves `examples` at runtime.
  return definePattern(spec) as AuthoredPattern;
}
