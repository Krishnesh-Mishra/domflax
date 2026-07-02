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

/**
 * A VERIFIED-REBUILDABLE variant token (`hover:px-4`, `md:h-10`, …): not unconditionally droppable,
 * but the resolver round-trip-validated that its exact full effect (root utility re-keyed under one
 * single condition) can be re-emitted. Reverse-emit may drop it ONLY under its mandatory re-resolve
 * equality backstop; every other consumer treats it exactly like {@link OPAQUE_USAGE}.
 */
export const REBUILDABLE_VARIANT_USAGE: SelectorUsage = {
  ...OPAQUE_USAGE,
  rebuildable: true,
};
