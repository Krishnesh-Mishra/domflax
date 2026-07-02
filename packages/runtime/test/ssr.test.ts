/**
 * @domflax/runtime — SSR safety (plain Node environment, no jsdom pragma).
 *
 * Importing the module must not touch document/DOMParser, and calling the
 * API without a DOM must return the input unchanged instead of throwing.
 */
import { describe, it, expect } from 'vitest';

import { createOptimizer, optimizeHtml, clearCache } from '../src/index';

describe('SSR / no-DOM environment', () => {
  it('runs in an environment without DOMParser', () => {
    expect(typeof DOMParser).toBe('undefined');
  });

  it('shared optimizeHtml returns the input unchanged without throwing', () => {
    const html = '<div><p>hi</p></div>';
    expect(() => optimizeHtml(html)).not.toThrow();
    expect(optimizeHtml(html)).toBe(html);
  });

  it('createOptimizer works and its optimizeHtml is a passthrough', () => {
    const opt = createOptimizer({ cacheSize: 10 });
    const html = '<span><b>x</b></span>';
    expect(opt.optimizeHtml(html)).toBe(html);
    expect(() => opt.clearCache()).not.toThrow();
  });

  it('clearCache on the shared optimizer does not throw', () => {
    expect(() => clearCache()).not.toThrow();
  });
});
