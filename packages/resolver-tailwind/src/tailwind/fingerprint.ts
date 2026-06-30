/**
 * @domflax/resolver-tailwind — tiny dependency-free hash for cache-busting fingerprints.
 */

/** Tiny, dependency-free FNV-1a string hash (hex). Used to derive the cache-busting fingerprint. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
