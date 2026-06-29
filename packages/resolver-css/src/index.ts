/**
 * @domflax/resolver-css — a {@link StyleResolver} backed by the project's own CSS files.
 *
 * Role: parse user-authored stylesheets, index every selector + declaration block, and answer
 * the resolver contract for plain `class="…"` tokens (forward `resolve`), reverse-emit synthetic
 * classes (`emit`), and report how each class participates in project selectors (`selectorUsage`)
 * so the compress phase knows what is safe to drop/rename.
 *
 * STAGE STATUS: typed stub. The class/factory shape, ids, ownership, and fingerprinting are real;
 * the parsing/cascade machinery throws `NotImplemented` until the real implementation lands.
 *
 * Intended future dependency: postcss (CSS parsing + selector tokenization). Kept OUT of
 * package.json on purpose — this stub defines minimal local shapes and implements against
 * @domflax/core types only.
 */

import type {
  EmitContext,
  EmitResult,
  ResolveInput,
  ResolveResult,
  SelectorUsage,
  StyleMap,
  StyleResolver,
} from '@domflax/core';

/* ────────────────────────────────────────────────────────────────────────── *
 * Local input shapes (no third-party types — postcss lands in a later stage)
 * ────────────────────────────────────────────────────────────────────────── */

/** A single user-authored stylesheet handed to the resolver. */
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
}

/** Stable resolver id surfaced on {@link StyleResolver.id}. */
export const CSS_RESOLVER_ID = 'css';

/** Provider tag surfaced on {@link StyleResolver.provider}. Tracks the intended parser. */
export const CSS_RESOLVER_PROVIDER = 'custom-css';

/* ────────────────────────────────────────────────────────────────────────── *
 * CustomCSSResolver
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Resolves plain CSS classes against a fixed set of project stylesheets.
 *
 * Everything that needs real CSS parsing throws `NotImplemented`; the metadata surface
 * (`id`/`provider`/`fingerprint`/`owns`) is honest so the resolver can already be wired into a
 * pipeline and fingerprinted for caching.
 */
export class CustomCSSResolver implements StyleResolver {
  public readonly id: string = CSS_RESOLVER_ID;
  public readonly provider: string = CSS_RESOLVER_PROVIDER;
  public readonly fingerprint: string;

  readonly #files: readonly CssFile[];

  public constructor(cssFiles: readonly CssFile[], options: CssResolverOptions = {}) {
    this.#files = cssFiles.slice();
    this.fingerprint = options.fingerprint ?? deriveFingerprint(this.provider, this.#files);
  }

  /** The stylesheets this resolver was constructed with (defensive copy). */
  public get files(): readonly CssFile[] {
    return this.#files;
  }

  /**
   * A custom-CSS resolver owns every plain class token; the real implementation will additionally
   * verify the token is actually declared by one of {@link files}. Until parsing lands we are
   * conservative and claim only tokens that look like valid CSS identifiers.
   */
  public owns(token: string): boolean {
    return isPlainClassToken(token);
  }

  public resolve(_input: ResolveInput): ResolveResult {
    throw new Error('NotImplemented: CustomCSSResolver.resolve lands in Stage 3');
  }

  public emit(_styles: StyleMap, _ctx: EmitContext): EmitResult {
    throw new Error('NotImplemented: CustomCSSResolver.emit lands in Stage 3');
  }

  public selectorUsage(_token: string): SelectorUsage {
    throw new Error('NotImplemented: CustomCSSResolver.selectorUsage lands in Stage 3');
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Factory
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Construct a {@link CustomCSSResolver} from the project's CSS files.
 * The thin factory mirrors the other resolver packages' construction surface.
 */
export function createCssResolver(
  cssFiles: readonly CssFile[],
  options?: CssResolverOptions,
): StyleResolver {
  return new CustomCSSResolver(cssFiles, options);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Internal helpers (trivial, real)
 * ────────────────────────────────────────────────────────────────────────── */

/** Cheap, allocation-free CSS-identifier check — good enough for the stub's `owns`. */
function isPlainClassToken(token: string): boolean {
  return token.length > 0 && !/[\s.#>+~:[\]()]/.test(token);
}

/**
 * Derive a deterministic fingerprint from the provider tag + each file's id and length.
 * A length-based digest is intentionally cheap; the real resolver will hash file content via the
 * postcss-parsed AST so theme/source-CSS edits bust downstream caches.
 */
function deriveFingerprint(provider: string, files: readonly CssFile[]): string {
  const parts = files
    .map((f) => `${f.id}:${f.css.length}`)
    .sort();
  return `${provider}::${parts.join('|')}`;
}
