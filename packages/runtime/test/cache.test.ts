// @vitest-environment jsdom
/**
 * @domflax/runtime — cache behavior.
 *
 * Parsing work is observed by spying on DOMParser.prototype.parseFromString:
 * a cache hit must not reparse, an evicted entry must reparse.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';

import { createOptimizer, optimizeHtml, clearCache } from '../src/index';

const wrap = (s: string) => `<div><p>${s}</p></div>`;

let parseSpy: MockInstance;

beforeEach(() => {
  clearCache();
  parseSpy = vi.spyOn(DOMParser.prototype, 'parseFromString');
});

afterEach(() => {
  parseSpy.mockRestore();
});

describe('cache hits', () => {
  it('parses a repeated input only once and returns the same result', () => {
    const opt = createOptimizer();
    const first = opt.optimizeHtml(wrap('a'));
    const second = opt.optimizeHtml(wrap('a'));
    expect(first).toBe('<p>a</p>');
    expect(second).toBe(first);
    expect(parseSpy).toHaveBeenCalledTimes(1);
  });

  it('also caches inputs that come back unchanged', () => {
    const opt = createOptimizer();
    const html = '<section><p>hi</p></section>';
    expect(opt.optimizeHtml(html)).toBe(html);
    expect(opt.optimizeHtml(html)).toBe(html);
    expect(parseSpy).toHaveBeenCalledTimes(1);
  });

  it('clearCache() on the shared optimizer forces a reparse', () => {
    optimizeHtml(wrap('x'));
    optimizeHtml(wrap('x'));
    expect(parseSpy).toHaveBeenCalledTimes(1);
    clearCache();
    optimizeHtml(wrap('x'));
    expect(parseSpy).toHaveBeenCalledTimes(2);
  });

  it('separate createOptimizer() instances have independent caches', () => {
    const a = createOptimizer();
    const b = createOptimizer();
    a.optimizeHtml(wrap('shared'));
    b.optimizeHtml(wrap('shared'));
    expect(parseSpy).toHaveBeenCalledTimes(2);
  });
});

describe('LRU eviction', () => {
  it('evicts the least recently used entry once cacheSize is exceeded', () => {
    const opt = createOptimizer({ cacheSize: 2 });

    opt.optimizeHtml(wrap('a')); // cache: a
    opt.optimizeHtml(wrap('b')); // cache: a, b
    expect(parseSpy).toHaveBeenCalledTimes(2);

    opt.optimizeHtml(wrap('a')); // hit — refreshes a's recency
    expect(parseSpy).toHaveBeenCalledTimes(2);

    opt.optimizeHtml(wrap('c')); // cache full → evicts b (LRU), keeps a
    expect(parseSpy).toHaveBeenCalledTimes(3);

    opt.optimizeHtml(wrap('a')); // still cached
    expect(parseSpy).toHaveBeenCalledTimes(3);

    opt.optimizeHtml(wrap('b')); // was evicted → reparse
    expect(parseSpy).toHaveBeenCalledTimes(4);
  });

  it('re-bounds the shared cache via a per-call cacheSize option', () => {
    optimizeHtml(wrap('a'));
    optimizeHtml(wrap('b'), { cacheSize: 1 }); // shrink to 1 → only b survives
    expect(parseSpy).toHaveBeenCalledTimes(2);

    optimizeHtml(wrap('b'));
    expect(parseSpy).toHaveBeenCalledTimes(2); // b still cached

    optimizeHtml(wrap('a'));
    expect(parseSpy).toHaveBeenCalledTimes(3); // a was evicted by the shrink

    optimizeHtml('', { cacheSize: 500 }); // restore the shared default bound
  });

  it('cacheSize 0 disables caching but still optimizes', () => {
    const opt = createOptimizer({ cacheSize: 0 });
    expect(opt.optimizeHtml(wrap('a'))).toBe('<p>a</p>');
    expect(opt.optimizeHtml(wrap('a'))).toBe('<p>a</p>');
    expect(parseSpy).toHaveBeenCalledTimes(2);
  });
});

describe('enabled flag', () => {
  it('createOptimizer({ enabled: false }) is a passthrough that never parses', () => {
    const opt = createOptimizer({ enabled: false });
    const html = wrap('a');
    expect(opt.optimizeHtml(html)).toBe(html);
    expect(parseSpy).not.toHaveBeenCalled();
  });

  it('optimizeHtml(html, { enabled: false }) is a passthrough that never parses', () => {
    const html = wrap('a');
    expect(optimizeHtml(html, { enabled: false })).toBe(html);
    expect(parseSpy).not.toHaveBeenCalled();
  });
});
