/**
 * @domflax/verify — the maintainer-side Tier-2 equivalence oracle.
 *
 * Renders the `before` and `after` source of a single-file transform in a real
 * headless browser and proves they are visually + structurally equivalent
 * across a matrix of viewports. For each viewport it runs three independent
 * passes (pixel, bounding-box, computed-style) and folds them into one verdict.
 *
 * The comparison is STRUCTURE-INDEPENDENT by design: node counts legitimately
 * change once a transform flattens wrappers, so leaves are matched by visual
 * role/text/position, never by DOM index (see {@link ./diff}).
 *
 * If no browser binary is available the verifier returns an `inconclusive`
 * verdict (never throws), so browserless CI stays green.
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
export { DEFAULT_STYLE_PROPERTIES } from './diff.js';
export { isBrowserAvailable } from './browser.js';
export type { LeafSnapshot, RenderArtifacts } from './render.js';

import type { Diagnostic } from '@domflax/core';
import type { Browser } from 'playwright';

import {
  DEFAULT_VIEWPORTS,
  DEFAULT_VERIFY_OPTIONS,
  type RenderTarget,
  type VerifyOptions,
  type VerifyResult,
  type ViewportResult,
  type Viewport,
  type BrowserEngine,
  type Equivalence,
} from './types.js';
import { launchBrowser } from './browser.js';
import { renderTarget } from './render.js';
import {
  DEFAULT_STYLE_PROPERTIES,
  pixelDiff,
  matchLeaves,
  diffBoxes,
  diffStyles,
} from './diff.js';

/** Fully-resolved options used by the render+diff engine. */
export interface ResolvedVerifyOptions {
  readonly viewports: readonly Viewport[];
  readonly engine: BrowserEngine;
  readonly pixelThreshold: number;
  readonly maxPixelRatio: number;
  readonly maxBoxDeltaPx: number;
  readonly styleProperties: readonly string[];
  readonly timeoutMs: number;
  readonly captureArtifacts: boolean;
}

/**
 * Merge caller options over the verifier defaults. Pure and total — safe to use
 * for config validation / dry-run planning.
 */
export function resolveVerifyOptions(opts: VerifyOptions = {}): ResolvedVerifyOptions {
  return {
    viewports: opts.viewports ?? DEFAULT_VIEWPORTS,
    engine: opts.engine ?? DEFAULT_VERIFY_OPTIONS.engine,
    pixelThreshold: opts.pixelThreshold ?? DEFAULT_VERIFY_OPTIONS.pixelThreshold,
    maxPixelRatio: opts.maxPixelRatio ?? DEFAULT_VERIFY_OPTIONS.maxPixelRatio,
    maxBoxDeltaPx: opts.maxBoxDeltaPx ?? DEFAULT_VERIFY_OPTIONS.maxBoxDeltaPx,
    styleProperties: opts.styleProperties ?? DEFAULT_STYLE_PROPERTIES,
    timeoutMs: opts.timeoutMs ?? DEFAULT_VERIFY_OPTIONS.timeoutMs,
    captureArtifacts: opts.captureArtifacts ?? DEFAULT_VERIFY_OPTIONS.captureArtifacts,
  };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Per-viewport verdict
 * ────────────────────────────────────────────────────────────────────────── */

async function verifyViewport(
  browser: Browser,
  before: RenderTarget,
  after: RenderTarget,
  vp: Viewport,
  resolved: ResolvedVerifyOptions,
): Promise<ViewportResult> {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.deviceScaleFactor ?? 1,
    reducedMotion: 'reduce',
    colorScheme: 'light',
    forcedColors: 'none',
  });

  try {
    const b = await renderTarget(context, before.code, resolved.styleProperties, resolved.timeoutMs);
    const a = await renderTarget(context, after.code, resolved.styleProperties, resolved.timeoutMs);

    const threshold01 = Math.min(1, Math.max(0, resolved.pixelThreshold / 255));
    const pixel = pixelDiff(b.png, a.png, threshold01, resolved.captureArtifacts);

    const pairs = matchLeaves(b.leaves, a.leaves);
    const boxes = diffBoxes(pairs);
    const styles = diffStyles(pairs, resolved.styleProperties);

    const pixelOk = pixel.changedRatio <= resolved.maxPixelRatio;
    const boxOk = boxes.every((box) => box.maxDelta <= resolved.maxBoxDeltaPx);
    const styleOk = styles.length === 0;
    const equivalence: Equivalence = pixelOk && boxOk && styleOk ? 'equivalent' : 'divergent';

    return {
      viewport: vp,
      equivalence,
      pixel,
      boxes,
      styles,
      ...(resolved.captureArtifacts ? { beforePng: b.png, afterPng: a.png } : {}),
    };
  } finally {
    await context.close();
  }
}

async function runVerification(
  browser: Browser,
  before: RenderTarget,
  after: RenderTarget,
  resolved: ResolvedVerifyOptions,
  startedAt: number,
): Promise<VerifyResult> {
  const viewports: ViewportResult[] = [];
  for (const vp of resolved.viewports) {
    viewports.push(await verifyViewport(browser, before, after, vp, resolved));
  }

  const equivalence: Equivalence = viewports.every((v) => v.equivalence === 'equivalent')
    ? 'equivalent'
    : 'divergent';

  return {
    equivalence,
    engine: resolved.engine,
    viewports,
    diagnostics: [],
    durationMs: Date.now() - startedAt,
  };
}

function inconclusiveResult(
  resolved: ResolvedVerifyOptions,
  startedAt: number,
  reason: string,
): VerifyResult {
  const diagnostic: Diagnostic = {
    code: 'DF_VERIFY_INCONCLUSIVE',
    severity: 'warn',
    message: reason,
  };
  return {
    equivalence: 'inconclusive',
    engine: resolved.engine,
    viewports: [],
    diagnostics: [diagnostic],
    durationMs: Date.now() - startedAt,
  };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Batching verifier (shared browser across many fixtures)
 * ────────────────────────────────────────────────────────────────────────── */

export interface Verifier {
  /** Verify one before/after pair. Per-call options override the verifier defaults. */
  verify(before: RenderTarget, after: RenderTarget, opts?: VerifyOptions): Promise<VerifyResult>;
  /** Close the shared browser. Safe to call multiple times. */
  close(): Promise<void>;
}

/**
 * Create a verifier that holds ONE browser open across many {@link Verifier.verify}
 * calls — the efficient path for validating a corpus of fixtures. The browser is
 * launched lazily on first use; if launch fails (no binary), every `verify` call
 * returns an `inconclusive` verdict rather than throwing.
 */
export function createVerifier(): Verifier {
  let browser: Browser | null = null;
  let launchFailed = false;

  async function ensureBrowser(engine: BrowserEngine): Promise<Browser | null> {
    if (browser) return browser;
    if (launchFailed) return null;
    try {
      browser = await launchBrowser(engine);
      return browser;
    } catch {
      launchFailed = true;
      return null;
    }
  }

  return {
    async verify(before, after, opts = {}) {
      const resolved = resolveVerifyOptions(opts);
      const startedAt = Date.now();
      const live = await ensureBrowser(resolved.engine);
      if (!live) {
        return inconclusiveResult(
          resolved,
          startedAt,
          `Browser engine '${resolved.engine}' could not be launched (binary not installed?); verification skipped.`,
        );
      }
      return runVerification(live, before, after, resolved, startedAt);
    },
    async close() {
      if (browser) {
        const b = browser;
        browser = null;
        await b.close().catch(() => undefined);
      }
    },
  };
}

/**
 * One-shot equivalence check: render `before` and `after` and prove visual +
 * structural equivalence across every viewport. Launches a single browser for
 * the call and closes it afterwards.
 *
 * Returns an `inconclusive` verdict (never throws) when no browser is available.
 */
export async function verifyEquivalence(
  before: RenderTarget,
  after: RenderTarget,
  opts: VerifyOptions = {},
): Promise<VerifyResult> {
  const verifier = createVerifier();
  try {
    return await verifier.verify(before, after, opts);
  } finally {
    await verifier.close();
  }
}
