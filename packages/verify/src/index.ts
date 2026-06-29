/**
 * @domflax/verify — equivalence verifier (TYPED STUB)
 *
 * Public surface: the result/option types plus `verifyEquivalence`, which will,
 * in a later stage, render `before` and `after` in a headless browser
 * (playwright), capture per-viewport screenshots, and diff them at the pixel,
 * bounding-box, and computed-style levels (pixelmatch + pngjs). For now it
 * resolves the effective options and throws NotImplemented.
 */

export type {
  RenderTarget,
  Viewport,
  BrowserEngine,
  VerifyOptions,
  BoundingBox,
  PixelDiff,
  BBoxDiff,
  StyleDiff,
  Equivalence,
  ViewportResult,
  VerifyResult,
} from './types.js';

export { DEFAULT_VIEWPORTS, DEFAULT_VERIFY_OPTIONS } from './types.js';

import {
  DEFAULT_VIEWPORTS,
  DEFAULT_VERIFY_OPTIONS,
  type RenderTarget,
  type VerifyOptions,
  type VerifyResult,
  type Viewport,
  type BrowserEngine,
} from './types.js';

/** Fully-resolved options used by the (future) render+diff engine. */
export interface ResolvedVerifyOptions {
  readonly viewports: readonly Viewport[];
  readonly engine: BrowserEngine;
  readonly pixelThreshold: number;
  readonly maxPixelRatio: number;
  readonly maxBoxDeltaPx: number;
  readonly styleProperties: readonly string[] | undefined;
  readonly timeoutMs: number;
  readonly captureArtifacts: boolean;
}

/**
 * Merge caller options over the verifier defaults. Pure and total — safe to use
 * for config validation / dry-run planning before the engine exists.
 */
export function resolveVerifyOptions(opts: VerifyOptions = {}): ResolvedVerifyOptions {
  return {
    viewports: opts.viewports ?? DEFAULT_VIEWPORTS,
    engine: opts.engine ?? DEFAULT_VERIFY_OPTIONS.engine,
    pixelThreshold: opts.pixelThreshold ?? DEFAULT_VERIFY_OPTIONS.pixelThreshold,
    maxPixelRatio: opts.maxPixelRatio ?? DEFAULT_VERIFY_OPTIONS.maxPixelRatio,
    maxBoxDeltaPx: opts.maxBoxDeltaPx ?? DEFAULT_VERIFY_OPTIONS.maxBoxDeltaPx,
    styleProperties: opts.styleProperties,
    timeoutMs: opts.timeoutMs ?? DEFAULT_VERIFY_OPTIONS.timeoutMs,
    captureArtifacts: opts.captureArtifacts ?? DEFAULT_VERIFY_OPTIONS.captureArtifacts,
  };
}

/**
 * Render `before` and `after` and prove visual + structural equivalence across
 * every viewport.
 *
 * @throws Error NotImplemented — the headless render + diff engine lands in a
 *   later stage. Options are still resolved eagerly so config errors surface now.
 */
export async function verifyEquivalence(
  before: RenderTarget,
  after: RenderTarget,
  opts: VerifyOptions = {},
): Promise<VerifyResult> {
  const resolved = resolveVerifyOptions(opts);
  void before;
  void after;
  void resolved;
  throw new Error(
    'NotImplemented: headless render + pixel/bbox/style equivalence diffing lands in Stage 5',
  );
}
