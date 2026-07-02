/**
 * @domflax/runtime — LruCache unit tests (pure JS, plain Node environment).
 */
import { describe, it, expect } from 'vitest';

import { LruCache } from '../src/lru';

describe('LruCache', () => {
  it('stores and retrieves values', () => {
    const c = new LruCache(2);
    c.set('a', '1');
    expect(c.get('a')).toBe('1');
    expect(c.get('missing')).toBeUndefined();
    expect(c.size).toBe(1);
  });

  it('evicts the least recently used entry at capacity', () => {
    const c = new LruCache(2);
    c.set('a', '1');
    c.set('b', '2');
    c.set('c', '3'); // evicts a
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBe('2');
    expect(c.get('c')).toBe('3');
    expect(c.size).toBe(2);
  });

  it('a get refreshes recency, protecting the entry from eviction', () => {
    const c = new LruCache(2);
    c.set('a', '1');
    c.set('b', '2');
    c.get('a'); // a is now most recent
    c.set('c', '3'); // evicts b, not a
    expect(c.get('a')).toBe('1');
    expect(c.get('b')).toBeUndefined();
  });

  it('overwriting a key refreshes its recency', () => {
    const c = new LruCache(2);
    c.set('a', '1');
    c.set('b', '2');
    c.set('a', '1b'); // a is now most recent
    c.set('c', '3'); // evicts b
    expect(c.get('a')).toBe('1b');
    expect(c.get('b')).toBeUndefined();
  });

  it('setMaxSize shrinks the cache, evicting oldest entries', () => {
    const c = new LruCache(3);
    c.set('a', '1');
    c.set('b', '2');
    c.set('c', '3');
    c.setMaxSize(1);
    expect(c.size).toBe(1);
    expect(c.get('c')).toBe('3'); // only the most recent survives
  });

  it('a max size of 0 stores nothing', () => {
    const c = new LruCache(0);
    c.set('a', '1');
    expect(c.get('a')).toBeUndefined();
    expect(c.size).toBe(0);
  });

  it('clear empties the cache', () => {
    const c = new LruCache(2);
    c.set('a', '1');
    c.clear();
    expect(c.size).toBe(0);
    expect(c.get('a')).toBeUndefined();
  });
});
