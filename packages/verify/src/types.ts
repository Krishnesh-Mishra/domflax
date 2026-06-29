/**
 * @domflax/verify — public type contract (TYPED STUB)
 *
 * Equivalence verifier: renders the `before` and `after` source of a single-file
 * transform in a real browser and proves they are visually + structurally
 * equivalent across a set of viewports. The heavy rendering/diffing engine
 * (playwright + pixelmatch + pngjs) lands in a later stage; this module defines
 * the FULL result/option surface and a NotImplemented entry point so downstream
 * packages can typecheck against the contract today.
 *
 * Future runtime deps (NOT in package.json by design — see SKILL build rules):
 *   - playwright   (headless render of before/after)
 *   - pixelmatch   (per-pixel image delta)
 *   - pngjs        (PNG decode for pixelmatch)
 */

import type { Diagnostic } from '@domflax/core';

/* ────────────────────────────────────────────────────────────────────────── *
 * Inputs
 * ────────────────────────────────────────────────────────────────────────── */

/** A rendered surface to compare. */
export interface RenderTarget {
  /** Stable label, e.g. 'before' | 'after'. */
  readonly label: string;
  /** Source code (JSX/TSX/HTML) to mount and render. */
  readonly code: string;
  /** Virtual module id / path, used for diagnostics + module resolution. */
  readonly id: string;
}

/** Logical viewport the page is rendered at. */
export interface Viewport {
  readonly name: string; // 'mobile' | 'tablet' | 'desktop' | author-defined
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor?: number; // default 1
}

/** Browser engine to drive (playwright channel). */
export type BrowserEngine = 'chromium' | 'firefox' | 'webkit';

export interface VerifyOptions {
  readonly viewports?: readonly Viewport[];
  readonly engine?: BrowserEngine;
  /** Per-channel 0–255 tolerance before a pixel counts as different. */
  readonly pixelThreshold?: number;
  /** Max fraction (0–1) of differing pixels still considered equivalent. */
  readonly maxPixelRatio?: number;
  /** Max bounding-box drift in CSS px before flagging a layout shift. */
  readonly maxBoxDeltaPx?: number;
  /** Computed-style properties to compare; omit to use the verifier default set. */
  readonly styleProperties?: readonly string[];
  /** Wall-clock budget per target render, in ms. */
  readonly timeoutMs?: number;
  /** When true, retain rendered PNGs/diffs in the result for debugging. */
  readonly captureArtifacts?: boolean;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Diff primitives
 * ────────────────────────────────────────────────────────────────────────── */

export interface BoundingBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Per-pixel comparison for one viewport. */
export interface PixelDiff {
  readonly width: number;
  readonly height: number;
  readonly totalPixels: number;
  readonly changedPixels: number;
  readonly changedRatio: number; // changedPixels / totalPixels
  /** Encoded PNG of the diff overlay; present only when captureArtifacts. */
  readonly diffPng?: Uint8Array;
}

/** Layout drift for a single matched element between before/after. */
export interface BBoxDiff {
  /** Best-effort selector / index path identifying the element. */
  readonly path: string;
  readonly before: BoundingBox | null; // null = absent on that side
  readonly after: BoundingBox | null;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaWidth: number;
  readonly deltaHeight: number;
  /** Max absolute component of the delta, in CSS px. */
  readonly maxDelta: number;
}

/** Computed-style mismatch for one property on one element. */
export interface StyleDiff {
  readonly path: string;
  readonly property: string;
  readonly before: string | null;
  readonly after: string | null;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Per-viewport + aggregate results
 * ────────────────────────────────────────────────────────────────────────── */

export type Equivalence = 'equivalent' | 'divergent' | 'inconclusive';

export interface ViewportResult {
  readonly viewport: Viewport;
  readonly equivalence: Equivalence;
  readonly pixel: PixelDiff;
  readonly boxes: readonly BBoxDiff[];
  readonly styles: readonly StyleDiff[];
  /** Present only when captureArtifacts. */
  readonly beforePng?: Uint8Array;
  readonly afterPng?: Uint8Array;
}

export interface VerifyResult {
  readonly equivalence: Equivalence;
  readonly engine: BrowserEngine;
  readonly viewports: readonly ViewportResult[];
  readonly diagnostics: readonly Diagnostic[];
  readonly durationMs: number;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Defaults
 * ────────────────────────────────────────────────────────────────────────── */

export const DEFAULT_VIEWPORTS: readonly Viewport[] = [
  { name: 'mobile', width: 375, height: 667, deviceScaleFactor: 2 },
  { name: 'tablet', width: 768, height: 1024, deviceScaleFactor: 2 },
  { name: 'desktop', width: 1280, height: 800, deviceScaleFactor: 1 },
] as const;

export const DEFAULT_VERIFY_OPTIONS = {
  engine: 'chromium',
  pixelThreshold: 2,
  maxPixelRatio: 0.0,
  maxBoxDeltaPx: 0.5,
  timeoutMs: 30_000,
  captureArtifacts: false,
} as const satisfies Partial<VerifyOptions> & { engine: BrowserEngine };
