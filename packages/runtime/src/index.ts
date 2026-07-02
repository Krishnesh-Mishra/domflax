/**
 * @domflax/runtime — tiny, dependency-free browser runtime.
 *
 * `optimizeHtml(html)` conservatively optimizes a dynamic HTML string right
 * before it is assigned to `innerHTML`. It removes only provably inert
 * wrappers (see ./optimize.ts) and NEVER changes rendering: any doubt — a
 * throw, a missing `DOMParser` (SSR), a parse that does not round-trip the
 * input byte-for-byte — returns the ORIGINAL string unchanged.
 *
 * Synchronous, cached (bounded LRU keyed by the input string), and SSR-safe:
 * nothing at module scope touches `document` or `DOMParser`.
 */
import { LruCache } from './lru';
import { optimizeBody } from './optimize';

export interface RuntimeOptions {
  /** Max number of input strings kept in the LRU cache. Default 500. */
  cacheSize?: number;
  /** When false, `optimizeHtml` is a passthrough. Default true. */
  enabled?: boolean;
}

export interface Optimizer {
  /** Optimize an HTML string; returns the input unchanged on any doubt. */
  optimizeHtml(html: string): string;
  /** Drop every cached result. */
  clearCache(): void;
}

const DEFAULT_CACHE_SIZE = 500;

/** Core loop shared by every optimizer instance. */
function optimizeWith(cache: LruCache, html: string): string {
  if (typeof html !== 'string' || html.length === 0) return html;

  const cached = cache.get(html);
  if (cached !== undefined) return cached;

  // SSR / non-browser: no DOMParser, no work, no caching.
  if (typeof DOMParser === 'undefined') return html;

  let result = html;
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const body = doc.body;
    if (!body) return html;

    // Faithfulness gate: only touch input the parser round-trips exactly.
    // Malformed / auto-corrected / normalized HTML (unclosed tags, foster-
    // parented table fragments, uppercase tags, unquoted attributes, content
    // hoisted into <head>) serializes differently — bail out so the output
    // can only ever differ from the input by our own transforms.
    if (body.innerHTML === html) {
      result = optimizeBody(body) ? body.innerHTML : html;
    }
  } catch {
    return html; // never cache a failure
  }

  cache.set(html, result);
  return result;
}

/**
 * Create an independent optimizer with its own cache.
 * Construction touches no DOM API — safe to call during SSR.
 */
export function createOptimizer(options: RuntimeOptions = {}): Optimizer {
  const enabled = options.enabled !== false;
  const cache = new LruCache(options.cacheSize ?? DEFAULT_CACHE_SIZE);

  return {
    optimizeHtml: (html: string) => (enabled ? optimizeWith(cache, html) : html),
    clearCache: () => cache.clear(),
  };
}

/** Cache backing the shared default optimizer (module-level convenience API). */
const defaultCache = new LruCache(DEFAULT_CACHE_SIZE);

/**
 * Optimize an HTML string using the shared default optimizer.
 *
 * Per-call options: `enabled: false` short-circuits to a passthrough;
 * `cacheSize` re-bounds the shared cache (evicting oldest entries if smaller).
 */
export function optimizeHtml(html: string, options?: RuntimeOptions): string {
  if (options?.enabled === false) return html;
  if (options?.cacheSize !== undefined) defaultCache.setMaxSize(options.cacheSize);
  return optimizeWith(defaultCache, html);
}

/** Clear the shared default optimizer's cache. */
export function clearCache(): void {
  defaultCache.clear();
}
