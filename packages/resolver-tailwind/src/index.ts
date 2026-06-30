/**
 * @domflax/resolver-tailwind — Tailwind-aware {@link StyleResolver}, backed by the REAL Tailwind
 * engine.
 *
 * ## Engine + approach
 *
 * This resolver is backed by **tailwindcss v3** (`resolveConfig` + the JIT context + `generateRules`),
 * NOT v4. The reason is the {@link StyleResolver} contract: `resolve()` is **synchronous**. Tailwind
 * v4's entire programmatic surface (`compile`, `compileAst`, `__unstable__loadDesignSystem`) returns
 * Promises and offers no synchronous design-system constructor, so backing a synchronous resolver
 * with v4 would require blocking-on-promise hacks. Tailwind v3's `createContext(resolveConfig(...))`
 * + `generateRules(candidates, ctx)` pipeline is fully synchronous — it is exactly the path that
 * tooling such as `prettier-plugin-tailwindcss` and the Tailwind IntelliSense engine use — so it
 * backs a synchronous resolver cleanly and is genuinely testable. The task explicitly permits this
 * fallback.
 *
 * ## Forward (`resolve`)
 *
 * `resolve(classes)` feeds each candidate class name to the real engine, reads back the generated
 * CSS rules, and converts them into a normalized, condition-keyed {@link StyleMap}:
 *
 *   • a simple `.utility { … }` rule contributes to the unconditional `BASE_CONDITION` block,
 *   • a `:hover` / `:focus` / … suffix becomes a `StyleCondition.states` entry,
 *   • a `::before` / `::placeholder` / … suffix becomes a `StyleCondition.pseudoElement`,
 *   • a wrapping `@media (…)` (responsive variants like `md:`) becomes `StyleCondition.media`.
 *
 * Every declaration is run through the SHARED {@link normalizer} from `@domflax/pattern-kit`, so
 * values are canonical and box shorthands (`p-4`, `gap-4`, `inset-0`, …) expand to longhands exactly
 * the way patterns + verify expect. BASE coverage is the must-have; variant conditions are produced
 * best-effort. Utilities whose selector uses a combinator / compound / attribute selector (e.g.
 * `space-x-4`, `divide-y`) cannot be folded onto the element's own box and are surfaced as
 * {@link OpaqueToken}s rather than contributing misleading declarations. Unknown / unresolvable
 * classes contribute nothing and are reported in `unknown` — `resolve` never throws.
 *
 * ## Reverse (`emit`)
 *
 * `emit(styleMap)` is best-effort reverse synthesis backed by a reverse index built from the engine's
 * own class list (`context.getClassList()`): each indexable utility is generated, its normalized BASE
 * declarations are recorded, and the index is greedily matched against the requested StyleMap
 * (largest declaration-sets first), consuming matched properties so each is mapped to at most one
 * utility. The index is built lazily on first `emit()` and cached.
 *
 * LIMITATION (v0.1.0): `emit` is intentionally less complete than `resolve`. It only matches against
 * the engine's enumerable named utilities and only their unconditional BASE declarations; variant
 * conditions (hover/responsive/pseudo-element) and arbitrary-value utilities are not reverse-synthesized,
 * and no synthetic class is produced for the residual (it is surfaced via `exact:false`). Anything
 * with no matching utility is simply left unmatched — `emit` never throws and never invents a class.
 */

import { createRequire } from 'node:module';
import * as path from 'node:path';

import type {
  CssProperty,
  EmitContext,
  EmitResult,
  OpaqueToken,
  ResolveInput,
  ResolveResult,
  SelectorUsage,
  StyleBlock,
  StyleCondition,
  StyleDecl,
  StyleMap,
  StyleOrigin,
  StyleResolver,
} from '@domflax/core';
import { BASE_CONDITION, conditionKey, emptyStyleMap } from '@domflax/core';
import { normalizer } from '@domflax/pattern-kit';

/* ───────────────────────── engine loading (synchronous v3 internals) ───────────────────────── */

// The forward/reverse engine lives in tailwindcss' CommonJS internals. We load them through
// `createRequire` (rather than `import`) so the exact same code path works whether this module is
// bundled to ESM or CJS, and so the untyped internal subpaths don't need ambient declarations.
//
// CRITICAL (bundling): tailwindcss must be resolved from the CONSUMER'S project, NOT from the file
// this module happens to live in. When `domflax` inlines this resolver into its own bundle
// (`noExternal: [/^@domflax\//]`), a require based on the bundle's location (`__filename`) would
// look for `tailwindcss` next to `domflax/dist`, where it does not exist — so the engine silently
// failed to load and `emit`'s reverse index came up empty. Instead we root the require in the user's
// project (an explicit project root, then `process.cwd()`), exactly how prettier-plugin-tailwindcss
// and the Tailwind IntelliSense engine locate a project's Tailwind. The bundle/source location is
// kept only as a last-resort fallback (covers the non-bundled / in-repo dev case). The first base
// from which `tailwindcss/package.json` resolves wins.

/**
 * This module's own location, used as a last-resort require base. esbuild substitutes a real
 * `__filename` in a CJS bundle; in an ESM bundle `__filename` is undefined and we fall back to
 * `import.meta.url` (a `file://` URL, which `createRequire` accepts).
 */
function moduleBase(): string {
  return typeof __filename === 'string' ? __filename : import.meta.url;
}

/**
 * Build a `require` rooted in the consumer's project so engine resolution is independent of where
 * this (possibly bundled) module physically lives. Returns `null` if `tailwindcss` resolves from no
 * candidate base.
 */
function projectRequire(projectRoot?: string): NodeRequire | null {
  const bases: string[] = [];
  // A real file name is irrelevant — `createRequire` only uses the containing directory for
  // resolution; the file need not exist.
  if (projectRoot) bases.push(path.join(projectRoot, '__domflax__.js'));
  bases.push(path.join(process.cwd(), '__domflax__.js'));
  bases.push(moduleBase());
  for (const base of bases) {
    try {
      const candidate = createRequire(base);
      candidate.resolve('tailwindcss/package.json');
      return candidate;
    } catch {
      /* try the next base */
    }
  }
  return null;
}

interface TwGeneratedDecl {
  readonly type: 'decl';
  readonly prop: string;
  readonly value: string;
  readonly important?: boolean;
}
interface TwGeneratedRule {
  readonly type: 'rule';
  readonly selector: string;
  readonly nodes?: readonly TwNode[];
}
interface TwGeneratedAtRule {
  readonly type: 'atrule';
  readonly name: string;
  readonly params: string;
  readonly nodes?: readonly TwNode[];
}
type TwNode = TwGeneratedDecl | TwGeneratedRule | TwGeneratedAtRule | { readonly type: string };

interface TwContext {
  getClassList(): unknown[];
}

interface TwEngine {
  readonly version: string;
  readonly context: TwContext;
  /** Generate the postcss rule nodes Tailwind emits for the given candidate class names. */
  generate(candidates: readonly string[]): TwNode[];
}

/** Build a synchronous Tailwind v3 engine for the given resolved config; returns `null` on failure. */
function loadEngine(options: TailwindResolverConfig): TwEngine | null {
  const req = projectRequire(options.projectRoot);
  if (!req) return null;
  try {
    const resolveConfig = req('tailwindcss/resolveConfig.js') as (c: unknown) => unknown;
    const { createContext } = req('tailwindcss/lib/lib/setupContextUtils.js') as {
      createContext: (config: unknown) => TwContext;
    };
    const { generateRules } = req('tailwindcss/lib/lib/generateRules.js') as {
      generateRules: (candidates: Set<string>, context: TwContext) => Array<[number, TwNode]>;
    };
    const pkg = req('tailwindcss/package.json') as { version: string };

    let userConfig: unknown = options.config ?? { content: [{ raw: '' }] };
    if (options.configPath !== undefined) {
      const loadConfig = req('tailwindcss/loadConfig.js') as (p: string) => unknown;
      userConfig = loadConfig(options.configPath);
    }
    const resolved = resolveConfig(userConfig);
    const context = createContext(resolved);

    return {
      version: pkg.version,
      context,
      generate(candidates: readonly string[]): TwNode[] {
        const rules = generateRules(new Set(candidates), context);
        return rules.map(([, node]) => node);
      },
    };
  } catch {
    return null;
  }
}

/* ───────────────────────── configuration ───────────────────────── */

/** Construction-time configuration for {@link createTailwindResolver}. */
export interface TailwindResolverConfig {
  /** Provider tag surfaced via {@link StyleResolver.provider}. Defaults to the engine version. */
  readonly provider?: string;
  /**
   * Cache-busting fingerprint. Defaults to a hash derived from the resolved Tailwind config (theme
   * etc.) combined with the provider tag, so it changes when the theme/config changes.
   */
  readonly fingerprint?: string;
  /**
   * A Tailwind (v3) config object, merged with the framework defaults via `resolveConfig`. Mutually
   * exclusive with {@link configPath} (path wins). Defaults to `{ content: [{ raw: '' }] }`.
   */
  readonly config?: Record<string, unknown>;
  /** Path to a project `tailwind.config.{js,cjs,mjs,ts}` file, loaded synchronously. */
  readonly configPath?: string;
  /**
   * Directory to resolve `tailwindcss` (and its v3 internals) from. Defaults to `process.cwd()`,
   * falling back to this module's location. Set this when the consumer's project root differs from
   * the working directory. Resolution is intentionally independent of where domflax's bundle lives.
   */
  readonly projectRoot?: string;
}

/* ───────────────────────── selector / condition parsing ───────────────────────── */

/** Pseudo-elements that Tailwind may emit with a legacy single colon. */
const LEGACY_PSEUDO_ELEMENTS = new Set([
  ':before',
  ':after',
  ':first-line',
  ':first-letter',
]);

type ParsedSelector =
  | { readonly kind: 'simple'; readonly states: readonly string[]; readonly pseudoElement: string }
  | { readonly kind: 'complex' };

/**
 * Parse a generated selector into a {@link StyleCondition} fragment. Accepts ONLY a single class
 * selector optionally followed by pseudo-class / pseudo-element parts (`.x`, `.x:hover`,
 * `.x::before`, `.x:focus:hover`). Anything with a combinator, a second compound class, an attribute
 * selector, or a selector list is `complex` (⇒ opaque) because its declarations do not apply to the
 * element's own box.
 */
function parseSelector(selector: string): ParsedSelector {
  const sel = selector.trim();
  if (sel.length === 0 || sel[0] !== '.') return { kind: 'complex' };

  // Consume the class identifier, honoring CSS backslash escapes (`\:`, `\/`, `\[`, …).
  let i = 1;
  for (; i < sel.length; i += 1) {
    const c = sel[i]!;
    if (c === '\\') {
      i += 1; // skip the escaped char
      continue;
    }
    if (c === ':' || c === '.' || c === '[' || c === ' ' || c === '>' || c === '+' || c === '~' || c === ',') {
      break;
    }
  }

  const remainder = sel.slice(i);
  if (remainder.length === 0) {
    return { kind: 'simple', states: [], pseudoElement: '' };
  }
  // The remainder must be EXCLUSIVELY pseudo parts — no combinator / compound / attribute follows.
  if (!/^(?:::?[-a-z]+(?:\([^()]*\))?)+$/i.test(remainder)) {
    return { kind: 'complex' };
  }

  const parts = remainder.match(/::?[-a-z]+(?:\([^()]*\))?/gi) ?? [];
  const states: string[] = [];
  let pseudoElement = '';
  for (const part of parts) {
    if (part.startsWith('::') || LEGACY_PSEUDO_ELEMENTS.has(part)) {
      pseudoElement = part.startsWith('::') ? part : `:${part}`;
    } else {
      states.push(part);
    }
  }
  return { kind: 'simple', states, pseudoElement };
}

function makeCondition(media: string, states: readonly string[], pseudoElement: string): StyleCondition {
  return {
    media,
    states: [...new Set(states)].sort(),
    pseudoElement,
  };
}

/* ───────────────────────── rule extraction ───────────────────────── */

interface ExtractedBlock {
  readonly condition: StyleCondition;
  readonly decls: ReadonlyArray<readonly [string, string, boolean]>;
}

interface ExtractedToken {
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
function extractToken(token: string, nodes: readonly TwNode[]): ExtractedToken {
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

/* ───────────────────────── StyleMap assembly ───────────────────────── */

function buildStyleMap(
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

/* ───────────────────────── conservative selector usage ───────────────────────── */

/**
 * A conservative, never-droppable {@link SelectorUsage}. Until a real project selector graph exists
 * we must assume a class could be referenced in any unsafe position, so nothing is safe to rewrite.
 */
const OPAQUE_USAGE: SelectorUsage = {
  asSubject: true,
  asAncestor: true,
  asCompound: true,
  asSibling: true,
  asHasArgument: true,
  asStructural: true,
  droppable: false,
};

/* ───────────────────────── fingerprint ───────────────────────── */

/** Tiny, dependency-free FNV-1a string hash (hex). Used to derive the cache-busting fingerprint. */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/* ───────────────────────── the resolver ───────────────────────── */

class TailwindResolver implements StyleResolver {
  readonly id = 'tailwind';
  readonly provider: string;
  readonly fingerprint: string;

  readonly #engine: TwEngine | null;
  /** Per-token extraction cache (engine output is pure for a fixed config). */
  readonly #tokenCache = new Map<string, ExtractedToken>();
  /** Per-class-set forward-resolution cache. */
  readonly #resolveCache = new Map<string, ResolveResult>();
  /** Lazily built reverse index for {@link emit}. */
  #reverseIndex: ReadonlyArray<readonly [string, ReadonlyMap<CssProperty, string>]> | null = null;

  constructor(config: TailwindResolverConfig = {}) {
    this.#engine = loadEngine(config);
    this.provider =
      config.provider ?? (this.#engine ? `tailwindcss@${this.#engine.version}` : 'tailwindcss');
    const seed = JSON.stringify(config.config ?? {}) + (config.configPath ?? '');
    this.fingerprint = config.fingerprint ?? `${this.provider}/${fnv1a(seed)}`;
  }

  /** Engine-backed, cached single-token extraction. */
  #extract(token: string): ExtractedToken {
    const cached = this.#tokenCache.get(token);
    if (cached) return cached;
    let result: ExtractedToken;
    if (!this.#engine) {
      result = { blocks: [], produced: false };
    } else {
      try {
        result = extractToken(token, this.#engine.generate([token]));
      } catch {
        result = { blocks: [], produced: false };
      }
    }
    this.#tokenCache.set(token, result);
    return result;
  }

  owns(token: string): boolean {
    if (token.length === 0) return false;
    return this.#extract(token).produced;
  }

  resolve(input: ResolveInput): ResolveResult {
    const key = JSON.stringify(input.classes);
    const cached = this.#resolveCache.get(key);
    if (cached) return cached;

    // condition-key → { condition, longhand decls }. Iterating classes in source order means later
    // utilities overwrite earlier ones on the same property (equal-specificity cascade).
    const blockMaps = new Map<
      string,
      { condition: StyleCondition; decls: Map<CssProperty, StyleDecl> }
    >();
    const resolved: string[] = [];
    const unknown: string[] = [];
    const opaque: OpaqueToken[] = [];

    input.classes.forEach((token, tokenIndex) => {
      const extracted = this.#extract(token);
      if (!extracted.produced) {
        unknown.push(token);
        return;
      }
      if (extracted.opaque) opaque.push(extracted.opaque);
      if (extracted.blocks.length === 0) return; // produced only opaque rules

      const origin: StyleOrigin = { kind: 'class', tokenIndex, className: token };
      let contributed = false;
      for (const block of extracted.blocks) {
        const ck = conditionKey(block.condition);
        let bucket = blockMaps.get(ck);
        if (!bucket) {
          bucket = { condition: block.condition, decls: new Map() };
          blockMaps.set(ck, bucket);
        }
        for (const [prop, value, important] of block.decls) {
          for (const decl of normalizer.normalizeDeclaration(prop, value, important)) {
            bucket.decls.set(decl.property, { ...decl, origin });
            contributed = true;
          }
        }
      }
      if (contributed) resolved.push(token);
    });

    const result: ResolveResult = {
      styles: buildStyleMap(blockMaps),
      resolved,
      unknown,
      opaque,
      warnings: [],
    };
    this.#resolveCache.set(key, result);
    return result;
  }

  /**
   * Lazily build the reverse index from the engine's own enumerable class list. Each indexable
   * utility maps to its NORMALIZED BASE longhand declarations (property → canonical value). Utilities
   * with variant conditions, combinator selectors, or no BASE declarations are skipped. Sorted by
   * declaration count (desc) so greedier (shorthand-like) utilities are tried first.
   */
  #buildReverseIndex(): ReadonlyArray<readonly [string, ReadonlyMap<CssProperty, string>]> {
    if (this.#reverseIndex) return this.#reverseIndex;
    const index: Array<readonly [string, Map<CssProperty, string>]> = [];
    if (this.#engine) {
      try {
        const classes = this.#engine.context
          .getClassList()
          .filter((c): c is string => typeof c === 'string');
        const nodes = this.#engine.generate(classes);
        // Re-extract per class would be costly; instead group decls by their (single) class selector.
        for (const node of nodes) {
          if (node.type !== 'rule') continue; // skip @media / @keyframes wrappers (⇒ variants only)
          const rule = node as TwGeneratedRule;
          const parsed = parseSelector(rule.selector);
          if (parsed.kind !== 'simple' || parsed.states.length > 0 || parsed.pseudoElement !== '') {
            continue; // BASE-only
          }
          const className = unescapeClass(rule.selector);
          if (className === null) continue;
          const decls = new Map<CssProperty, string>();
          for (const child of rule.nodes ?? []) {
            if (child.type !== 'decl') continue;
            const d = child as TwGeneratedDecl;
            if (typeof d.value !== 'string') continue;
            for (const decl of normalizer.normalizeDeclaration(d.prop, d.value, d.important === true)) {
              decls.set(decl.property, String(decl.value));
            }
          }
          if (decls.size > 0) index.push([className, decls]);
        }
      } catch {
        /* leave index empty on failure — emit degrades to a no-op */
      }
    }
    index.sort((a, b) => b[1].size - a[1].size || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    this.#reverseIndex = index;
    return index;
  }

  emit(styles: StyleMap, ctx: EmitContext): EmitResult {
    const norm = ctx.normalizer ?? normalizer;
    const base = norm.normalizeStyleMap(styles).blocks.get(conditionKey(BASE_CONDITION));
    if (!base || base.decls.size === 0) return { classes: [], exact: true, warnings: [] };

    // Only the BASE block is reverse-synthesized (see module LIMITATION). Any non-base condition
    // present in the target means we cannot be exact.
    const hasNonBase = norm.normalizeStyleMap(styles).blocks.size > 1;

    const remaining = new Map<CssProperty, string>();
    for (const [prop, decl] of base.decls) remaining.set(prop, String(decl.value));

    const classes: string[] = [];
    for (const [token, declMap] of this.#buildReverseIndex()) {
      if (declMap.size === 0 || declMap.size > remaining.size) continue;
      let matches = true;
      for (const [prop, value] of declMap) {
        if (remaining.get(prop) !== value) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;
      classes.push(token);
      for (const prop of declMap.keys()) remaining.delete(prop);
      if (remaining.size === 0) break;
    }

    return { classes, exact: remaining.size === 0 && !hasNonBase, warnings: [] };
  }

  selectorUsage(_token: string): SelectorUsage {
    // Conservative default: no project selector graph yet, so treat every class as load-bearing.
    return OPAQUE_USAGE;
  }
}

/** Recover a class name from a simple `.escaped-class` selector, or `null` if it isn't simple. */
function unescapeClass(selector: string): string | null {
  const sel = selector.trim();
  if (sel[0] !== '.') return null;
  let out = '';
  for (let i = 1; i < sel.length; i += 1) {
    const c = sel[i]!;
    if (c === '\\') {
      i += 1;
      if (i < sel.length) out += sel[i];
      continue;
    }
    if (c === ':' || c === '.' || c === '[' || c === ' ' || c === '>' || c === '+' || c === '~' || c === ',') {
      return null; // not a bare single-class selector
    }
    out += c;
  }
  return out.length > 0 ? out : null;
}

/** Factory: build a Tailwind-backed {@link StyleResolver}. */
export function createTailwindResolver(config?: TailwindResolverConfig): StyleResolver {
  return new TailwindResolver(config);
}
