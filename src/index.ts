/**
 * domflax — compile-time DOM flattener and semantic CSS compressor.
 *
 * Goal: emit the smallest possible DOM that renders identically to the source.
 * It does this in two composable layers:
 *   1. Flatten  — remove redundant wrapper nodes (reduce node count).
 *   2. Compress — collapse verbose class/style sets to minimal equivalents.
 *
 * Matching happens on *computed styles*, not raw class names, so the same
 * pattern library works across Tailwind, custom CSS, and (later) other
 * providers. See README for the design.
 *
 * v0: dummy export. The real transform pipeline lands after the architecture
 * design phase.
 */

export const version = '0.0.1'

export type CSSProvider = 'auto' | 'tailwind' | 'custom'

export interface FlaxeOptions {
  /** How class names are resolved to computed styles. Default: 'auto'. */
  provider?: CSSProvider
  /** Paths to CSS files to parse when provider is 'custom'. */
  cssFiles?: string[]
  /** Preview changes without rewriting source. Default: false. */
  dryRun?: boolean
}

/**
 * Placeholder transform. Returns the input unchanged for now.
 *
 * Planned pipeline:
 *   parse → resolve styles → flatten nodes → compress classes → emit
 */
export function flatten(code: string, _options: FlaxeOptions = {}): string {
  return code
}
