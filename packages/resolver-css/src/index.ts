/**
 * @domflax/resolver-css — a {@link StyleResolver} backed by the project's own CSS files.
 *
 * Role: parse user-authored stylesheets with postcss, index every selector + declaration block, and
 * answer the resolver contract for plain `class="…"` tokens:
 *
 *   • `resolve(classes)` — FORWARD. Union the declarations of every rule whose selector is a simple
 *     `.class` selector (optionally qualified by state pseudo-classes / a pseudo-element / wrapped in
 *     an `@media`, which become {@link StyleCondition}s) into a normalized, condition-keyed
 *     {@link StyleMap}. The shared {@link normalizer} expands shorthands and canonicalizes values so
 *     resolver + patterns + verify agree byte-for-byte. Equal-specificity single-class rules cascade
 *     by SOURCE order (later wins); BASE is the unconditional must-have block.
 *   • `emit(styles)` — REVERSE. Best-effort map a {@link StyleMap} back to the minimal set of existing
 *     class names whose own declarations are all present in the target. If nothing matches it returns
 *     no classes and `exact:false`; it never throws.
 *   • `selectorUsage(token)` — how a class participates in project selectors (subject / ancestor /
 *     sibling / compound / `:has()` argument / structural pseudo), driving compress safety. Backed by
 *     postcss-selector-parser so combinator and structural-pseudo facts are accurate.
 *   • {@link CustomCSSResolver.complexSelectors} — the list of COMPLEX selectors (anything with a
 *     combinator or a structural pseudo). This feeds domflax's CSS-selector-safety guard.
 *
 * CSS is accepted as raw sources (id + text) and/or as file paths read synchronously from disk, so
 * the resolver is fully unit-testable without touching the filesystem. Malformed CSS never throws —
 * an unparseable stylesheet simply contributes nothing; only genuine input errors (e.g. an
 * unreadable file path) surface as thrown errors.
 */

import type {
  ConditionKey,
  CssProperty,
  EmitContext,
  EmitResult,
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
import { conditionKey, emptyStyleMap } from '@domflax/core';
import { normalizer } from '@domflax/pattern-kit';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { AtRule, Root as PostcssRoot, Rule } from 'postcss';
import type selectorParser from 'postcss-selector-parser';

/* ────────────────────────────────────────────────────────────────────────── *
 * Lazy engine loading (postcss + postcss-selector-parser)
 * ────────────────────────────────────────────────────────────────────────── *
 *
 * postcss and postcss-selector-parser are OPTIONAL peers of the published `domflax` package: a
 * Tailwind-only user need not install them. They must therefore be loaded LAZILY (only when this
 * resolver is actually constructed) and from the CONSUMER'S project — never via a static top-level
 * `import`, which would (a) crash on module load for a postcss-less install and (b), once this
 * resolver is inlined into domflax's bundle, resolve relative to `domflax/dist` instead of the
 * user's project. We root the require in `process.cwd()` (or an explicit project root), exactly as
 * the Tailwind resolver does, with the bundle/source location as a last-resort fallback.
 */

/** This module's own location — esbuild fills `__filename` in CJS; ESM falls back to `import.meta.url`. */
function moduleBase(): string {
  return typeof __filename === 'string' ? __filename : import.meta.url;
}

/** The single postcss entry point this resolver calls at runtime. */
type PostcssParseApi = (css: string, opts?: { from?: string }) => PostcssRoot;

/** The subset of the postcss-selector-parser API this resolver calls at runtime (guards preserve narrowing). */
interface SelectorParserApi {
  (): { astSync(selector: string): selectorParser.Root };
  isClassName(n: selectorParser.Node): n is selectorParser.ClassName;
  isTag(n: selectorParser.Node): n is selectorParser.Tag;
  isIdentifier(n: selectorParser.Node): n is selectorParser.Identifier;
  isAttribute(n: selectorParser.Node): n is selectorParser.Attribute;
  isUniversal(n: selectorParser.Node): n is selectorParser.Universal;
  isNesting(n: selectorParser.Node): n is selectorParser.Nesting;
  isPseudo(n: selectorParser.Node): n is selectorParser.Pseudo;
  isPseudoClass(n: selectorParser.Node): n is selectorParser.Pseudo;
  isPseudoElement(n: selectorParser.Node): n is selectorParser.Pseudo;
  isCombinator(n: selectorParser.Node): n is selectorParser.Combinator;
}

interface PostcssEngine {
  readonly parse: PostcssParseApi;
  readonly selectorParser: SelectorParserApi;
}

/** Resolve postcss + postcss-selector-parser from the consumer's project; `null` if unavailable. */
function loadPostcssEngine(projectRoot?: string): PostcssEngine | null {
  const bases: string[] = [];
  if (projectRoot) bases.push(path.join(projectRoot, '__domflax__.js'));
  bases.push(path.join(process.cwd(), '__domflax__.js'));
  bases.push(moduleBase());
  for (const base of bases) {
    try {
      const req = createRequire(base);
      req.resolve('postcss');
      req.resolve('postcss-selector-parser');
      const postcss = req('postcss') as { parse: PostcssParseApi };
      const raw = req('postcss-selector-parser') as SelectorParserApi & { default?: SelectorParserApi };
      // postcss-selector-parser is CJS with a default export under interop; accept both shapes.
      const selector = raw.default ?? raw;
      return { parse: postcss.parse, selectorParser: selector };
    } catch {
      /* try the next base */
    }
  }
  return null;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Public input shapes
 * ────────────────────────────────────────────────────────────────────────── */

/** A single user-authored stylesheet handed to the resolver as raw text. */
export interface CssFile {
  /** Stable identifier (usually the absolute path) — also feeds the fingerprint. */
  readonly id: string;
  /** Verbatim stylesheet text. */
  readonly css: string;
}

/** Construction options for {@link CustomCSSResolver}. */
export interface CssResolverOptions {
  /** Overrides the auto-derived cache-busting fingerprint (e.g. a content hash from the caller). */
  readonly fingerprint?: string;
  /**
   * Additional stylesheet paths read synchronously from disk and appended to the raw `cssFiles`.
   * A path that cannot be read is a genuine input error and is rethrown with context.
   */
  readonly files?: readonly string[];
  /**
   * Directory to resolve `postcss` / `postcss-selector-parser` from. Defaults to `process.cwd()`,
   * falling back to this module's location. Resolution is independent of where domflax's bundle lives.
   */
  readonly projectRoot?: string;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Lazily-loaded postcss engine (module singleton)
 * ────────────────────────────────────────────────────────────────────────── */

/** Runtime postcss `parse`, populated on first resolver construction. */
let pc: PostcssParseApi | null = null;
/** Runtime postcss-selector-parser, populated on first resolver construction. */
let sp: SelectorParserApi | null = null;

/** Ensure the postcss engine is loaded; throws a clear error if the optional peers are absent. */
function ensurePostcss(projectRoot?: string): void {
  if (pc && sp) return;
  const engine = loadPostcssEngine(projectRoot);
  if (!engine) {
    throw new Error(
      '@domflax/resolver-css requires "postcss" and "postcss-selector-parser" to be installed in ' +
        'your project (they are optional peer dependencies of domflax, loaded only when the custom-CSS ' +
        'provider is used). Install them with: npm install postcss postcss-selector-parser',
    );
  }
  pc = engine.parse;
  sp = engine.selectorParser;
}

/** Stable resolver id surfaced on {@link StyleResolver.id}. */
export const CSS_RESOLVER_ID = 'css';

/** Provider tag surfaced on {@link StyleResolver.provider}. */
export const CSS_RESOLVER_PROVIDER = 'custom-css';

/** Version stamp for the index/cascade machinery; bump when its semantics change (cache-busting). */
const ENGINE_VERSION = 'css-index@1';

/** Structural pseudo-classes — their presence makes a class structurally targeted (review-1 blocker). */
const STRUCTURAL_PSEUDOS: ReadonlySet<string> = new Set([
  ':nth-child',
  ':nth-last-child',
  ':first-child',
  ':last-child',
  ':only-child',
  ':nth-of-type',
  ':nth-last-of-type',
  ':first-of-type',
  ':last-of-type',
  ':only-of-type',
]);

/** Functional pseudos whose argument is itself a selector list — opaque to forward resolution. */
const FUNCTIONAL_PSEUDOS: ReadonlySet<string> = new Set([
  ':not',
  ':is',
  ':where',
  ':has',
  ':matches',
]);

/** Legacy single-colon pseudo-ELEMENTS that the parser may not flag via `isPseudoElement`. */
const LEGACY_PSEUDO_ELEMENTS: ReadonlySet<string> = new Set([
  ':before',
  ':after',
  ':first-line',
  ':first-letter',
]);

/* ────────────────────────────────────────────────────────────────────────── *
 * Internal index shapes
 * ────────────────────────────────────────────────────────────────────────── */

type RawDecl = readonly [property: string, value: string, important: boolean];

/** One simple-`.class` rule's contribution, tagged with its document position for cascade ordering. */
interface RuleEntry {
  readonly order: number;
  readonly token: string;
  readonly condition: StyleCondition;
  readonly decls: readonly RawDecl[];
}

interface MutableUsage {
  referenced: boolean;
  asSubject: boolean;
  asAncestor: boolean;
  asCompound: boolean;
  asSibling: boolean;
  asHasArgument: boolean;
  asStructural: boolean;
  /** Appears anywhere other than as the lone subject of a bare `.x {}` selector. */
  loadBearing: boolean;
}

interface ReverseEntry {
  readonly token: string;
  /** `${conditionKey} ${property}` → canonical value, over this class's own resolution. */
  readonly keyed: ReadonlyMap<string, string>;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * CustomCSSResolver
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Resolves plain CSS classes against a fixed set of project stylesheets parsed with postcss.
 */
export class CustomCSSResolver implements StyleResolver {
  public readonly id: string = CSS_RESOLVER_ID;
  public readonly provider: string = CSS_RESOLVER_PROVIDER;
  public readonly fingerprint: string;

  readonly #files: readonly CssFile[];
  /** Forward map: class token → simple-`.class` rule contributions (source order). */
  readonly #classIndex = new Map<string, RuleEntry[]>();
  /** Selector-participation facts per class token. */
  readonly #usage = new Map<string, MutableUsage>();
  /** Every class referenced anywhere in the stylesheets (forward-resolvable or not). */
  readonly #known = new Set<string>();
  /** Distinct COMPLEX selectors (combinator or structural pseudo), sorted. */
  readonly #complex: readonly string[];

  #reverse: readonly ReverseEntry[] | null = null;

  public constructor(cssFiles: readonly CssFile[] = [], options: CssResolverOptions = {}) {
    ensurePostcss(options.projectRoot);
    const fromDisk = (options.files ?? []).map(readCssPath);
    this.#files = [...cssFiles, ...fromDisk];
    this.fingerprint = options.fingerprint ?? deriveFingerprint(this.provider, this.#files);

    const complex = new Set<string>();
    let order = 0;
    for (const file of this.#files) {
      order = this.#indexFile(file, order, complex);
    }
    this.#complex = [...complex].sort();
  }

  /** The stylesheets this resolver was constructed with (raw sources + any read from disk). */
  public get files(): readonly CssFile[] {
    return this.#files;
  }

  /** Owns any plain class token referenced by one of {@link files}. */
  public owns(token: string): boolean {
    return isPlainClassToken(token) && this.#known.has(token);
  }

  public resolve(input: ResolveInput): ResolveResult {
    const styles = this.#resolveTokens(input.classes, input.classes);
    const resolved: string[] = [];
    const unknown: string[] = [];
    for (const token of input.classes) {
      if (this.#classIndex.has(token)) resolved.push(token);
      else unknown.push(token);
    }
    return { styles, resolved, unknown, opaque: [], warnings: [] };
  }

  public emit(styles: StyleMap, ctx: EmitContext): EmitResult {
    const norm = ctx.normalizer ?? normalizer;
    const remaining = new Map<string, string>();
    for (const [ck, block] of norm.normalizeStyleMap(styles).blocks) {
      for (const [prop, decl] of block.decls) {
        remaining.set(`${ck} ${prop}`, String(decl.value));
      }
    }
    if (remaining.size === 0) return { classes: [], exact: true, warnings: [] };

    const classes: string[] = [];
    // Greedy set-cover: larger classes first so the emitted set stays minimal.
    for (const { token, keyed } of this.#reverseIndex()) {
      let matches = true;
      for (const [key, value] of keyed) {
        if (remaining.get(key) !== value) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;
      classes.push(token);
      for (const key of keyed.keys()) remaining.delete(key);
      if (remaining.size === 0) break;
    }

    // Unmatched declarations are left as-is (no synthetic residual) — surfaced via `exact:false`.
    return { classes, exact: remaining.size === 0, warnings: [] };
  }

  public selectorUsage(token: string): SelectorUsage {
    const u = this.#usage.get(token);
    if (!u) {
      return {
        asSubject: false,
        asAncestor: false,
        asCompound: false,
        asSibling: false,
        asHasArgument: false,
        asStructural: false,
        droppable: true,
      };
    }
    return {
      asSubject: u.asSubject,
      asAncestor: u.asAncestor,
      asCompound: u.asCompound,
      asSibling: u.asSibling,
      asHasArgument: u.asHasArgument,
      asStructural: u.asStructural,
      // Safe to drop/rename only when every reference is the lone subject of a bare `.x {}`.
      droppable: u.referenced && !u.loadBearing,
    };
  }

  /**
   * The distinct COMPLEX selectors found across all stylesheets — anything containing a combinator
   * (descendant / `>` / `+` / `~`) or a structural pseudo (`:nth-child`, `:first-child`, …). Feeds
   * domflax's CSS-selector-safety guard.
   */
  public complexSelectors(): readonly string[] {
    return this.#complex;
  }

  /* ─────────────────────────── internals ─────────────────────────── */

  /** Parse one stylesheet and fold its rules into the indexes. Returns the advanced order counter. */
  #indexFile(file: CssFile, startOrder: number, complex: Set<string>): number {
    let order = startOrder;
    let root;
    try {
      root = pc!(file.css, { from: file.id });
    } catch {
      // Malformed CSS contributes nothing (never throws — only clear input errors do).
      return order;
    }

    root.walkRules((rule) => {
      const media = mediaContext(rule);
      if (media.skip) return; // inside @keyframes / @font-face etc. — not class rules
      const decls = collectDecls(rule);

      let ast;
      try {
        ast = sp!().astSync(rule.selector);
      } catch {
        return;
      }

      for (const sel of ast.nodes) {
        const thisOrder = order;
        this.#analyzeSelector(sel as selectorParser.Selector, media.media, decls, thisOrder, complex);
      }
      order += 1;
    });

    return order;
  }

  /** Analyze one comma-segment selector: forward indexing, usage facts, complex detection. */
  #analyzeSelector(
    selector: selectorParser.Selector,
    media: string,
    decls: readonly RawDecl[],
    order: number,
    complex: Set<string>,
  ): void {
    const compounds = splitCompounds(selector);
    let hasCombinator = false;
    let hasStructural = false;

    compounds.forEach((compound, index) => {
      const isSubject = index === compounds.length - 1;
      const rightCombinator = index < compounds.length - 1 ? compounds[index + 1]!.leftCombinator : null;
      if (rightCombinator) hasCombinator = true;

      const classes = compound.nodes.filter((n) => sp!.isClassName(n));
      const otherSimple = compound.nodes.some(
        (n) =>
          sp!.isTag(n) ||
          sp!.isIdentifier(n) ||
          sp!.isAttribute(n) ||
          sp!.isUniversal(n) ||
          sp!.isNesting(n),
      );
      const pseudos = compound.nodes.filter((n) => sp!.isPseudo(n));
      const structuralPseudo = pseudos.some((p) => STRUCTURAL_PSEUDOS.has(pseudoName(p)));
      const functionalPseudo = pseudos.some((p) => FUNCTIONAL_PSEUDOS.has(pseudoName(p)));
      const statePseudos = pseudos.filter(
        (p) =>
          sp!.isPseudoClass(p) &&
          !STRUCTURAL_PSEUDOS.has(pseudoName(p)) &&
          !FUNCTIONAL_PSEUDOS.has(pseudoName(p)),
      );
      const elementPseudos = pseudos.filter((p) => isPseudoElement(p));
      const qualified = classes.length > 1 || otherSimple || functionalPseudo || statePseudos.length > 0;

      if (structuralPseudo) hasStructural = true;

      for (const cls of classes) {
        const token = cls.value;
        this.#known.add(token);
        const u = this.#getUsage(token);
        u.referenced = true;
        if (isSubject) u.asSubject = true;
        if (rightCombinator === ' ' || rightCombinator === '>') u.asAncestor = true;
        if (rightCombinator === '+' || rightCombinator === '~') u.asSibling = true;
        if (qualified) u.asCompound = true;
        if (structuralPseudo) u.asStructural = true;
        if (rightCombinator !== null || qualified || structuralPseudo || elementPseudos.length > 0) {
          u.loadBearing = true;
        }

        // Forward indexing: a single bare `.class` compound, optionally qualified by state
        // pseudo-classes and/or a pseudo-element, with NO other simple selector and NO
        // structural/functional pseudo and NO combinator on this compound's right edge.
        const forwardEligible =
          compounds.length === 1 &&
          classes.length === 1 &&
          !otherSimple &&
          !structuralPseudo &&
          !functionalPseudo &&
          elementPseudos.length <= 1;
        if (forwardEligible && decls.length > 0) {
          const condition: StyleCondition = {
            media,
            states: statePseudos.map(pseudoName).sort(),
            pseudoElement: elementPseudos.length === 1 ? normalizePseudoElement(elementPseudos[0]!) : '',
          };
          this.#addRuleEntry(token, { order, token, condition, decls });
        }
      }

      // Classes nested inside selector-argument pseudos (:has/:is/:where/:not) are references too.
      for (const p of pseudos) {
        const isHas = pseudoName(p) === ':has';
        p.walkClasses((inner) => {
          const token = inner.value;
          this.#known.add(token);
          const u = this.#getUsage(token);
          u.referenced = true;
          u.loadBearing = true;
          if (isHas) u.asHasArgument = true;
        });
      }
    });

    if (hasCombinator || hasStructural) {
      complex.add(selector.toString().trim());
    }
  }

  #addRuleEntry(token: string, entry: RuleEntry): void {
    const list = this.#classIndex.get(token);
    if (list) list.push(entry);
    else this.#classIndex.set(token, [entry]);
  }

  #getUsage(token: string): MutableUsage {
    let u = this.#usage.get(token);
    if (!u) {
      u = {
        referenced: false,
        asSubject: false,
        asAncestor: false,
        asCompound: false,
        asSibling: false,
        asHasArgument: false,
        asStructural: false,
        loadBearing: false,
      };
      this.#usage.set(token, u);
    }
    return u;
  }

  /**
   * Resolve a set of tokens into a normalized condition-keyed StyleMap. `tokenList` is the original
   * class list (for per-declaration `tokenIndex` provenance); `request` is the set being resolved.
   */
  #resolveTokens(request: readonly string[], tokenList: readonly string[]): StyleMap {
    const entries: RuleEntry[] = [];
    for (const token of new Set(request)) {
      const list = this.#classIndex.get(token);
      if (list) entries.push(...list);
    }
    if (entries.length === 0) return emptyStyleMap();

    // Equal-specificity single-class rules cascade by source order — later wins.
    entries.sort((a, b) => a.order - b.order);

    const acc = new Map<ConditionKey, { condition: StyleCondition; decls: Map<CssProperty, StyleDecl> }>();
    for (const entry of entries) {
      const key = conditionKey(entry.condition);
      let block = acc.get(key);
      if (!block) {
        block = { condition: entry.condition, decls: new Map() };
        acc.set(key, block);
      }
      const tokenIndex = tokenList.indexOf(entry.token);
      const origin: StyleOrigin = { kind: 'class', tokenIndex, className: entry.token };
      for (const [prop, value, important] of entry.decls) {
        for (const decl of normalizer.normalizeDeclaration(prop, value, important)) {
          block.decls.set(decl.property, { ...decl, origin });
        }
      }
    }

    const rawBlocks = new Map<ConditionKey, StyleBlock>();
    for (const [key, block] of acc) {
      if (block.decls.size === 0) continue;
      rawBlocks.set(key, { condition: block.condition, decls: block.decls });
    }
    if (rawBlocks.size === 0) return emptyStyleMap();
    return normalizer.normalizeStyleMap({ blocks: rawBlocks });
  }

  /** Build (once) the reverse index used by {@link emit}. */
  #reverseIndex(): readonly ReverseEntry[] {
    if (this.#reverse) return this.#reverse;
    const out: ReverseEntry[] = [];
    for (const token of this.#classIndex.keys()) {
      const styles = this.#resolveTokens([token], [token]);
      const keyed = new Map<string, string>();
      for (const [ck, block] of styles.blocks) {
        for (const [prop, decl] of block.decls) keyed.set(`${ck} ${prop}`, String(decl.value));
      }
      if (keyed.size > 0) out.push({ token, keyed });
    }
    // Larger declaration sets first → greedy minimal cover in `emit`.
    out.sort((a, b) => b.keyed.size - a.keyed.size);
    this.#reverse = out;
    return out;
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Factory
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Construct a {@link CustomCSSResolver} from raw CSS sources and/or file paths.
 *
 * @param cssFiles raw stylesheets (`{ id, css }`) — pass `[]` when loading only from disk.
 * @param options  optional disk paths (`files`) and/or an explicit `fingerprint`.
 */
export function createCssResolver(
  cssFiles: readonly CssFile[] = [],
  options?: CssResolverOptions,
): StyleResolver {
  return new CustomCSSResolver(cssFiles, options);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Selector helpers
 * ────────────────────────────────────────────────────────────────────────── */

interface Compound {
  /** The combinator immediately to this compound's LEFT (`null` for the first compound). */
  readonly leftCombinator: string | null;
  readonly nodes: readonly selectorParser.Node[];
}

/** Split a selector's flat node list into compounds delimited by combinator nodes. */
function splitCompounds(selector: selectorParser.Selector): Compound[] {
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
function pseudoName(node: selectorParser.Pseudo): string {
  return node.value.toLowerCase();
}

function isPseudoElement(node: selectorParser.Pseudo): boolean {
  return sp!.isPseudoElement(node) || LEGACY_PSEUDO_ELEMENTS.has(pseudoName(node));
}

/** Canonicalize a pseudo-element to the modern double-colon form (e.g. `:before` → `::before`). */
function normalizePseudoElement(node: selectorParser.Pseudo): string {
  const name = pseudoName(node);
  return name.startsWith('::') ? name : `::${name.replace(/^:/, '')}`;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * postcss helpers
 * ────────────────────────────────────────────────────────────────────────── */

interface MediaContext {
  readonly media: string;
  /** True when the rule lives under an at-rule that is not a style context (keyframes/font-face). */
  readonly skip: boolean;
}

/** Walk a rule's at-rule ancestry, collecting `@media` params and detecting non-style contexts. */
function mediaContext(rule: Rule): MediaContext {
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
function collectDecls(rule: Rule): RawDecl[] {
  const out: RawDecl[] = [];
  for (const node of rule.nodes) {
    if (node.type === 'decl') out.push([node.prop, node.value, node.important === true]);
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Misc helpers
 * ────────────────────────────────────────────────────────────────────────── */

/** Cheap, allocation-free CSS-identifier check used by {@link CustomCSSResolver.owns}. */
function isPlainClassToken(token: string): boolean {
  return token.length > 0 && !/[\s.#>+~:[\]()]/.test(token);
}

/** Read a CSS file from disk; surfaces unreadable paths as a clear input error. */
function readCssPath(path: string): CssFile {
  try {
    return { id: path, css: readFileSync(path, 'utf8') };
  } catch (cause) {
    throw new Error(`resolver-css: cannot read CSS file "${path}"`, { cause });
  }
}

/**
 * Derive a deterministic fingerprint from the provider tag, engine version, and each file's id +
 * length. Cheap and good enough to bust downstream caches when the source CSS set changes.
 */
function deriveFingerprint(provider: string, files: readonly CssFile[]): string {
  const parts = files.map((f) => `${f.id}:${f.css.length}`).sort();
  return `${provider}/${ENGINE_VERSION}::${parts.join('|')}`;
}
