/**
 * @domflax/verify — deterministic headless render + artifact capture.
 *
 * Accepts an HTML-string fragment (or a full document) and produces, for a
 * single viewport:
 *   - a viewport-clipped PNG screenshot (equal dimensions for before/after, so
 *     pixelmatch never sees a size mismatch), and
 *   - the list of VISUAL LEAVES with their bounding boxes + computed styles.
 *
 * Determinism is pinned hard: animations/transitions/caret disabled, reduced
 * motion forced, fonts awaited, and layout settled across two animation frames
 * before anything is measured.
 */

import type { BrowserContext } from 'playwright';

/** A measured visual leaf — see {@link extractLeaves}. */
export interface LeafSnapshot {
  /** Lower-cased tag name. */
  readonly tag: string;
  /** ARIA role if set, else the tag — the structure-independent identity. */
  readonly role: string;
  /** Trimmed direct text content (own text nodes only). */
  readonly text: string;
  /** Layout geometry in CSS pixels, viewport-relative. */
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  /** Requested computed-style properties, raw (normalization happens in diff). */
  readonly styles: Record<string, string>;
}

export interface RenderArtifacts {
  readonly png: Uint8Array;
  readonly leaves: readonly LeafSnapshot[];
}

/** Injected stylesheet that neutralizes every source of non-determinism. */
const DETERMINISM_CSS = [
  '*,*::before,*::after{',
  'animation-duration:0s!important;animation-delay:0s!important;',
  'transition-duration:0s!important;transition-delay:0s!important;',
  'caret-color:transparent!important;scroll-behavior:auto!important}',
  '::-webkit-scrollbar{display:none!important}',
].join('');

/** Wrap a bare fragment in a minimal, margin-reset document; pass full docs through. */
function wrapHtml(code: string): string {
  if (/<html[\s>]/i.test(code) || /<!doctype/i.test(code)) return code;
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<style>html,body{margin:0;padding:0;background:#fff}</style></head>' +
    `<body>${code}</body></html>`
  );
}

/**
 * In-page probe. Runs in the browser, so it depends on DOM globals only (no
 * closure over Node state — playwright serializes it to the page).
 *
 * A "visual leaf" is any painted element that either has no element children,
 * or carries its own direct text — i.e. the smallest units that actually draw
 * something. Matching on these (rather than every node) is what makes the
 * comparison survive wrapper flattening.
 */
function extractLeaves(props: readonly string[]): LeafSnapshot[] {
  const leaves: LeafSnapshot[] = [];
  const all = Array.from(document.querySelectorAll('*'));
  for (const el of all) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;

    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number.parseFloat(cs.opacity) === 0) {
      continue;
    }

    const directText = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent ?? '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim();

    const hasElementChild = el.children.length > 0;
    if (hasElementChild && directText === '') continue; // pure container ⇒ not a leaf

    const styles: Record<string, string> = {};
    for (const p of props) styles[p] = cs.getPropertyValue(p);

    leaves.push({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') ?? el.tagName.toLowerCase(),
      text: directText,
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      styles,
    });
  }
  return leaves;
}

/**
 * Render one target in a fresh page within the given (viewport-configured)
 * context, then capture the screenshot + visual leaves. The page is always
 * closed; the context/browser are owned by the caller for reuse.
 */
export async function renderTarget(
  context: BrowserContext,
  code: string,
  properties: readonly string[],
  timeoutMs: number,
): Promise<RenderArtifacts> {
  const page = await context.newPage();
  try {
    await page.setContent(wrapHtml(code), { waitUntil: 'load', timeout: timeoutMs });
    await page.addStyleTag({ content: DETERMINISM_CSS });

    // Settle: fonts loaded, then two rAFs so layout + paint are stable.
    await page.evaluate(async () => {
      try {
        await document.fonts.ready;
      } catch {
        /* document.fonts unsupported — ignore */
      }
    });
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );

    const buffer = await page.screenshot({ animations: 'disabled', caret: 'hide' });
    const leaves = await page.evaluate(extractLeaves, properties);
    return { png: new Uint8Array(buffer), leaves };
  } finally {
    await page.close();
  }
}
