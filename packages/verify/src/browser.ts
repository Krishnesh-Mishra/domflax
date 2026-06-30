/**
 * @domflax/verify — headless browser lifecycle.
 *
 * One shared {@link Browser} is launched and reused across every viewport and
 * every fixture in a run (see {@link ./index}'s `createVerifier`), which is the
 * batching primitive the maintainer-side oracle needs when validating many
 * fixtures at once.
 *
 * Critically, a launch failure (no downloaded browser binary on a bare CI box)
 * is reported as a value, never thrown past the public API — the verifier then
 * returns an `inconclusive` verdict instead of hard-failing.
 */

import { chromium, firefox, webkit, type Browser } from 'playwright';

import type { BrowserEngine } from './types.js';

const ENGINES = { chromium, firefox, webkit } as const;

/** Deterministic launch flags: fixed colour profile, no scrollbars, no sandbox. */
const CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--force-color-profile=srgb',
  '--hide-scrollbars',
  '--disable-lcd-text',
] as const;

/**
 * Launch the requested engine. Throws if the browser binary isn't installed —
 * callers MUST treat that as "inconclusive", not "divergent".
 */
export async function launchBrowser(engine: BrowserEngine): Promise<Browser> {
  const type = ENGINES[engine];
  return type.launch({
    headless: true,
    args: engine === 'chromium' ? [...CHROMIUM_ARGS] : [],
  });
}

/**
 * Probe whether the engine can actually launch on this machine. Used by tests
 * to `skipIf` cleanly when no browser is present, keeping browserless CI green.
 */
export async function isBrowserAvailable(engine: BrowserEngine = 'chromium'): Promise<boolean> {
  let browser: Browser | null = null;
  try {
    browser = await launchBrowser(engine);
    return true;
  } catch {
    return false;
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}
