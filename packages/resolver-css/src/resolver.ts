import type {
  ConditionKey,
  CoverClass,
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
import { conditionKey, emptyStyleMap, minStringCover, styleMapTuples } from '@domflax/core';
import { normalizer } from '@domflax/pattern-kit';
import type selectorParser from 'postcss-selector-parser';
import {
  CSS_RESOLVER_ID,
  CSS_RESOLVER_PROVIDER,
  FUNCTIONAL_PSEUDOS,
  STRUCTURAL_PSEUDOS,
} from './constants';
import { ensurePostcss, pc, sp } from './engine';
import { collectDecls, mediaContext } from './postcss-helpers';
import { deriveFingerprint, isPlainClassToken, readCssPath } from './misc-helpers';
import {
  isPseudoElement,
  normalizePseudoElement,
  pseudoName,
  splitCompounds,
} from './selector-helpers';
import type {
  CssFile,
  CssResolverOptions,
  MutableUsage,
  RawDecl,
  ReverseEntry,
  RuleEntry,
} from './types';

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
  /** Lazily built cover vocabulary (full condition-keyed tuple sets) for the exact-cover engine. */
  #coverVocab: readonly CoverClass[] | null = null;

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
    const normalized = norm.normalizeStyleMap(styles);

    // Primary path: the provider-uniform minimal-string exact cover over the whole class vocabulary —
    // this is what lets custom CSS finally compress (pick the shortest class set, or the single
    // semantic class, that reproduces the target; drop a class another class fully covers). The
    // element's own droppable tokens are members of the vocabulary, so a cover always exists when the
    // target is reproducible. The chosen set is verified by the mandatory re-resolve backstop below.
    const universe = styleMapTuples(normalized, norm);
    if (universe.length === 0) return { classes: [], exact: true, warnings: [] };
    const chosen = minStringCover(universe, this.#buildCoverVocab());
    if (chosen && chosen.length > 0) {
      const reTuples = new Set(styleMapTuples(this.resolve({ classes: chosen }).styles, norm));
      let ok = reTuples.size === universe.length;
      if (ok) for (const t of universe) if (!reTuples.has(t)) { ok = false; break; }
      if (ok) return { classes: chosen, exact: true, warnings: [] };
    }

    // Fallback: the original greedy set-cover (also surfaces uncovered decls via `exact:false`).
    const remaining = new Map<string, string>();
    for (const [ck, block] of normalized.blocks) {
      for (const [prop, decl] of block.decls) {
        remaining.set(`${ck} ${prop}`, String(decl.value));
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

  /**
   * Return a CSS stylesheet defining the given class tokens, so a verifier can render a subtree with
   * the project's real styling applied. The source stylesheets ARE the definition, so we hand back
   * their concatenation verbatim (every relevant rule — including combinator/structural selectors —
   * is preserved). `classes` is accepted for interface parity but the full source is always returned.
   */
  public cssFor(_classes: readonly string[]): string {
    return this.#files.map((f) => f.css).join('\n');
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

  /**
   * Build (once) the cover vocabulary for the exact-cover engine: every forward-resolvable class
   * mapped to the {@link styleMapTuples} of its full (condition-keyed, `!important`-aware) declaration
   * set. Unlike {@link #reverseIndex} this carries ALL style conditions and the important flag, so the
   * engine can pick a custom class covering hover/media declarations too.
   */
  #buildCoverVocab(): readonly CoverClass[] {
    if (this.#coverVocab) return this.#coverVocab;
    const out: CoverClass[] = [];
    for (const token of this.#classIndex.keys()) {
      const tuples = styleMapTuples(this.#resolveTokens([token], [token]), normalizer);
      if (tuples.length > 0) out.push({ token, tuples });
    }
    this.#coverVocab = out;
    return out;
  }

  /** Build (once) the reverse index used by the greedy {@link emit} fallback. */
  #reverseIndex(): readonly ReverseEntry[] {
    if (this.#reverse) return this.#reverse;
    const out: ReverseEntry[] = [];
    for (const token of this.#classIndex.keys()) {
      const styles = this.#resolveTokens([token], [token]);
      const keyed = new Map<string, string>();
      for (const [ck, block] of styles.blocks) {
        for (const [prop, decl] of block.decls) keyed.set(`${ck} ${prop}`, String(decl.value));
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
