/**
 * @domflax/resolver-tailwind — conservative {@link SelectorUsage} constants.
 */

import type { SelectorUsage } from '@domflax/core';

/**
 * A conservative, never-droppable {@link SelectorUsage}. Until a real project selector graph exists
 * we must assume a class could be referenced in any unsafe position, so nothing is safe to rewrite.
 */
export const OPAQUE_USAGE: SelectorUsage = {
  asSubject: true,
  asAncestor: true,
  asCompound: true,
  asSibling: true,
  asHasArgument: true,
  asStructural: true,
  droppable: false,
};

/**
 * A plain-subject {@link SelectorUsage}: the class is a resolver-owned, base-only utility whose
 * whole effect is reproducible from `computed`, so it is safe to drop/replace during reverse-emit.
 */
export const DROPPABLE_USAGE: SelectorUsage = {
  asSubject: true,
  asAncestor: false,
  asCompound: false,
  asSibling: false,
  asHasArgument: false,
  asStructural: false,
  droppable: true,
};
