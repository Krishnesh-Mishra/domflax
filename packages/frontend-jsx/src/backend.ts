/**
 * @domflax/frontend-jsx — IR → JSX backend (TYPED STUB, Stage 1).
 *
 * The real implementation replays the `EditPlan`'s ops as `magic-string` splices
 * against the retained verbatim source (using `BackrefTable` spans), reverse-emits
 * synthetic classes through `BackendContext.sink`, and produces an `EncodedSourceMap`.
 *
 * Future deps (NOT yet in package.json — land in Stage 1):
 *   @babel/types, magic-string
 */

import type {
  Backend,
  BackendContext,
  CodegenResult,
  EditPlan,
  FileKind,
  IRDocument,
} from '@domflax/core';

const JSX_LANGS: readonly FileKind[] = ['jsx', 'tsx'];

export const jsxBackend: Backend = {
  name: 'babel-jsx',
  langs: JSX_LANGS,

  print(_doc: IRDocument, _plan: EditPlan, _ctx: BackendContext): CodegenResult {
    throw new Error('NotImplemented: IR → JSX surgical codegen lands in Stage 1');
  },
};

/** Factory mirror — lets callers obtain a fresh instance (config wiring lands in Stage 1). */
export function createJsxBackend(): Backend {
  return jsxBackend;
}
