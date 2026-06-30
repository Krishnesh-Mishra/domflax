/**
 * @domflax/patterns — the built-in rewrite pattern library.
 *
 * Re-exports each pattern individually plus a default {@link builtinPatterns} array the
 * orchestrator/pipeline registers into its passes. Patterns are authored with the declarative
 * `pattern()` API from `@domflax/pattern-kit` and live under `flatten/` and `compress/`; this barrel
 * registers the full set (flatten then compress).
 */

import type { Pattern } from '@domflax/core';

import { flexCenterWrapper } from './flatten/flex-center-wrapper';
import { emptyStyleDiv } from './flatten/empty-style-div';
import { passthroughWrapper } from './flatten/passthrough-wrapper';
import { redundantFragment } from './flatten/redundant-fragment';
import { nestedFlexMerge } from './flatten/nested-flex-merge';
import { sizeShorthand } from './compress/size-shorthand';
import { paddingShorthand } from './compress/padding-shorthand';
import { marginShorthand } from './compress/margin-shorthand';
import { insetShorthand } from './compress/inset-shorthand';
import { dedupeClasses } from './compress/dedupe-classes';

export { flexCenterWrapper } from './flatten/flex-center-wrapper';
export { emptyStyleDiv } from './flatten/empty-style-div';
export { passthroughWrapper } from './flatten/passthrough-wrapper';
export { redundantFragment } from './flatten/redundant-fragment';
export { nestedFlexMerge } from './flatten/nested-flex-merge';
export { sizeShorthand } from './compress/size-shorthand';
export { paddingShorthand } from './compress/padding-shorthand';
export { marginShorthand } from './compress/margin-shorthand';
export { insetShorthand } from './compress/inset-shorthand';
export { dedupeClasses } from './compress/dedupe-classes';

/** Every built-in pattern, in registration order (flatten patterns before compress). */
export const builtinPatterns: readonly Pattern[] = [
  flexCenterWrapper,
  emptyStyleDiv,
  passthroughWrapper,
  redundantFragment,
  nestedFlexMerge,
  sizeShorthand,
  paddingShorthand,
  marginShorthand,
  insetShorthand,
  dedupeClasses,
];

export default builtinPatterns;
