/**
 * Minimal bounded LRU cache keyed by string.
 *
 * Uses a Map's insertion order to track recency: a `get` hit re-inserts the
 * entry, so the first key in iteration order is always the least recently used.
 * Zero dependencies — this is the only state the runtime keeps.
 */
export class LruCache {
  private map = new Map<string, string>();

  constructor(private maxSize: number) {}

  get size(): number {
    return this.map.size;
  }

  /** Re-bound the cache, evicting oldest entries if it shrank. */
  setMaxSize(maxSize: number): void {
    this.maxSize = maxSize;
    this.trim();
  }

  get(key: string): string | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key) as string;
    // Refresh recency: move the entry to the end of the iteration order.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: string): void {
    if (this.maxSize <= 0) return;
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    this.trim();
  }

  clear(): void {
    this.map.clear();
  }

  private trim(): void {
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}
