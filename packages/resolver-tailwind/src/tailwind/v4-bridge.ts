/**
 * @domflax/resolver-tailwind — SYNCHRONOUS bridge to Tailwind v4's async design-system API.
 *
 * The {@link StyleResolver} contract is fully synchronous, but every v4 programmatic entry point
 * (`__unstable__loadDesignSystem`, `compile`) returns a Promise and there is no synchronous
 * design-system constructor. Rather than a blocking-on-promise hack in-process, we run the async load
 * ONCE, at resolver construction, inside a short-lived child `node` process via `execFileSync` (which
 * is synchronous by nature). The child loads the project's real design system, enumerates its full
 * class list, and returns each utility's CSS (`candidatesToCss`) as `[className, css]` pairs. The
 * parent then drives everything synchronously off that snapshot — forward resolution is a map lookup +
 * {@link parseUtilityCss}, and the reverse index is built from the same pairs.
 *
 * SAFETY: the child is fully guarded and its result is treated as advisory — ANY failure (missing
 * `@tailwindcss/node`, load error, timeout, non-JSON output) makes {@link runV4Bridge} return `null`,
 * and the caller then falls back to the fail-safe (every class UNKNOWN ⇒ files left unchanged).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

/** A single CSS entry the child should try to load the design system from. */
export interface V4CssEntry {
  readonly css: string;
  readonly base: string;
}

export interface V4BridgePayload {
  readonly projectRoot: string;
  /** Candidate CSS entries, tried in order until one loads (the last is a minimal default). */
  readonly entries: readonly V4CssEntry[];
}

export interface V4BridgeResult {
  /** `[className, cssText]` for every utility whose `candidatesToCss` produced CSS. */
  readonly entries: ReadonlyArray<readonly [string, string]>;
}

/**
 * The child script, kept as a source STRING (not an imported module) so it survives domflax's bundle
 * and resolves the project's Tailwind independently of where the bundle physically lives. Written to a
 * temp `.mjs` at runtime and executed with `node <script> <payload.json>`; it prints a JSON result.
 */
const CHILD_SOURCE = String.raw`
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';

function out(obj) { process.stdout.write(JSON.stringify(obj)); process.exit(0); }

let payload;
try { payload = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); }
catch { out({ ok: false }); }

const projectRoot = payload.projectRoot;
const entries = payload.entries || [];
const req = createRequire(path.join(projectRoot, '__domflax_tw4__.js'));

async function importFrom(id) {
  const resolved = req.resolve(id);
  return import(pathToFileURL(resolved).href);
}

// Primary loader: @tailwindcss/node (the companion every v4 build tool installs). It resolves
// '@import "tailwindcss"' and @theme against the project on disk.
async function loadViaNode() {
  let mod;
  try { mod = await importFrom('@tailwindcss/node'); } catch { return null; }
  if (!mod || typeof mod.__unstable__loadDesignSystem !== 'function') return null;
  for (const e of entries) {
    try { return await mod.__unstable__loadDesignSystem(e.css, { base: e.base }); } catch {}
  }
  return null;
}

// Secondary loader: bare 'tailwindcss' with a filesystem stylesheet resolver (best-effort).
async function loadViaCore() {
  let tw;
  try { tw = await importFrom('tailwindcss'); } catch { return null; }
  if (!tw || typeof tw.__unstable__loadDesignSystem !== 'function') return null;
  const loadStylesheet = async (id, base) => {
    const r = createRequire(path.join(base, '__domflax_tw4__.js'));
    let p;
    const tries = id === 'tailwindcss' ? ['tailwindcss/index.css', 'tailwindcss'] : [id, id + '/index.css'];
    for (const t of tries) { try { p = r.resolve(t); break; } catch {} }
    if (!p) p = path.resolve(base, id);
    return { path: p, base: path.dirname(p), content: fs.readFileSync(p, 'utf8') };
  };
  const loadModule = async (id, base) => {
    const r = createRequire(path.join(base, '__domflax_tw4__.js'));
    const p = r.resolve(id);
    return { path: p, base: path.dirname(p), module: (await import(pathToFileURL(p).href)).default };
  };
  for (const e of entries) {
    try { return await tw.__unstable__loadDesignSystem(e.css, { base: e.base, loadStylesheet, loadModule }); } catch {}
  }
  return null;
}

const ds = (await loadViaNode()) || (await loadViaCore());
if (!ds) out({ ok: false });

let names = [];
try {
  names = ds.getClassList().map((e) => (Array.isArray(e) ? e[0] : e)).filter((n) => typeof n === 'string');
} catch { out({ ok: false }); }

let css = [];
try { css = ds.candidatesToCss(names); } catch { out({ ok: false }); }

const result = [];
for (let i = 0; i < names.length; i += 1) {
  const c = css[i];
  if (typeof c === 'string' && c.length > 0) result.push([names[i], c]);
}
out({ ok: true, entries: result });
`;

/**
 * Run the v4 bridge synchronously. Returns the class→CSS snapshot, or `null` on ANY failure (the
 * caller then uses the fail-safe path). Never throws.
 */
export function runV4Bridge(payload: V4BridgePayload): V4BridgeResult | null {
  let dir: string | null = null;
  try {
    dir = mkdtempSync(path.join(tmpdir(), 'domflax-tw4-'));
    const scriptPath = path.join(dir, 'bridge.mjs');
    const payloadPath = path.join(dir, 'payload.json');
    writeFileSync(scriptPath, CHILD_SOURCE, 'utf8');
    writeFileSync(payloadPath, JSON.stringify(payload), 'utf8');

    const stdout = execFileSync(process.execPath, [scriptPath, payloadPath], {
      cwd: payload.projectRoot,
      encoding: 'utf8',
      timeout: 90_000,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const parsed = JSON.parse(stdout) as { ok?: boolean; entries?: Array<[string, string]> };
    if (!parsed.ok || !Array.isArray(parsed.entries) || parsed.entries.length === 0) return null;
    const entries = parsed.entries.filter(
      (e): e is [string, string] =>
        Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string',
    );
    return entries.length > 0 ? { entries } : null;
  } catch {
    return null;
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    }
  }
}
