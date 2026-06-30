import { readFileSync } from 'node:fs';
import { ENGINE_VERSION } from './constants';
import type { CssFile } from './types';

/* ────────────────────────────────────────────────────────────────────────── *
 * Misc helpers
 * ────────────────────────────────────────────────────────────────────────── */

/** Cheap, allocation-free CSS-identifier check used by {@link CustomCSSResolver.owns}. */
export function isPlainClassToken(token: string): boolean {
  return token.length > 0 && !/[\s.#>+~:[\]()]/.test(token);
}

/** Read a CSS file from disk; surfaces unreadable paths as a clear input error. */
export function readCssPath(path: string): CssFile {
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
export function deriveFingerprint(provider: string, files: readonly CssFile[]): string {
  const parts = files.map((f) => `${f.id}:${f.css.length}`).sort();
  return `${provider}/${ENGINE_VERSION}::${parts.join('|')}`;
}
