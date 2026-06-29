/**
 * @domflax/patterns — the built-in rewrite pattern library.
 *
 * Re-exports each pattern individually plus a default {@link builtinPatterns} array the
 * orchestrator/pipeline registers into its passes. Stage 1 ships the single flatten pattern
 * `flex-center-wrapper`; later stages append to this barrel.
 */

import type { Pattern } from '@domflax/core';

import { flexCenterWrapper } from './flatten/flex-center-wrapper';

export { flexCenterWrapper } from './flatten/flex-center-wrapper';

/** Every built-in pattern, in registration order. */
export const builtinPatterns: readonly Pattern[] = [flexCenterWrapper];

export default builtinPatterns;
