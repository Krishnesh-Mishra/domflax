/**
 * @domflax/resolver-tailwind — construction-time configuration.
 */

import type { StyleResolver } from '@domflax/core';

/** Construction-time configuration for {@link createTailwindResolver}. */
export interface TailwindResolverConfig {
  /** Provider tag surfaced via {@link StyleResolver.provider}. Defaults to the engine version. */
  readonly provider?: string;
  /**
   * Cache-busting fingerprint. Defaults to a hash derived from the resolved Tailwind config (theme
   * etc.) combined with the provider tag, so it changes when the theme/config changes.
   */
  readonly fingerprint?: string;
  /**
   * A Tailwind (v3) config object, merged with the framework defaults via `resolveConfig`. Mutually
   * exclusive with {@link configPath} (path wins). Defaults to `{ content: [{ raw: '' }] }`.
   */
  readonly config?: Record<string, unknown>;
  /** Path to a project `tailwind.config.{js,cjs,mjs,ts}` file, loaded synchronously. */
  readonly configPath?: string;
  /**
   * Directory to resolve `tailwindcss` (and its v3 internals) from. Defaults to `process.cwd()`,
   * falling back to this module's location. Set this when the consumer's project root differs from
   * the working directory. Resolution is intentionally independent of where domflax's bundle lives.
   */
  readonly projectRoot?: string;
}
