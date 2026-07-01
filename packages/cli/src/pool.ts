/**
 * @domflax/cli — memory-safe parallel worker pool (FEATURE B).
 *
 * Processes many files across CPU cores without ever OOM-crashing. The design is memory-bounded BY
 * CONSTRUCTION: the main thread holds only the PATH list + aggregate stats; each worker is handed one
 * path at a time (work-stealing — it asks for the next when done), does read → transform → write, and
 * posts back only stats numbers. File contents never live on the main thread, so in-flight files ==
 * worker count.
 *
 * Safety layers:
 *   • WORKER COUNT = clamp(1, cpus-1, floor(budgetMB / PER_WORKER_MB)); `--concurrency` caps directly,
 *     `--max-memory` (or ~70% of free RAM) sets the budget — so low RAM ⇒ few workers ⇒ slow but works.
 *   • Each worker's V8 old-generation is capped (`resourceLimits.maxOldGenerationSizeMb`) so it GCs
 *     hard instead of ballooning.
 *   • A bad file is caught in the worker (reported failed, pool continues). A worker that DIES is caught
 *     on main: its in-flight file is marked failed, a replacement worker is spawned, and dispatch
 *     continues. The pool always finishes with "N optimized, M failed" — never a total crash.
 *   • Optional RSS backpressure pauses dispatch if resident memory nears the budget.
 *
 * Small jobs (files ≤ max(4, 2×workers), or workers ≤ 1) skip the pool entirely — the caller runs the
 * existing inline path, avoiding worker-startup + engine-load overhead.
 */

import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import type { CliOptions } from './options';
import type { WritePlan } from './safety';
import type { FileStats } from './transform';

/* ───────────────────────── tuning constants ───────────────────────── */

/**
 * Generous per-worker memory reservation (MB). Each worker builds its own transform engine
 * (Tailwind/postcss) plus one in-flight file; ~160MB comfortably covers the heavier Tailwind path, so
 * we never provision more workers than RAM can hold.
 */
export const PER_WORKER_MB = 160;

/** Floor for a worker's V8 old-generation cap — below this V8 thrashes; keep a sane minimum. */
const MIN_OLD_GEN_MB = 64;

/* ───────────────────────── aggregate stats ───────────────────────── */

export interface Totals {
  files: number;
  changed: number;
  nodesRemoved: number;
  classesSaved: number;
  bytesSaved: number;
}

export function emptyTotals(): Totals {
  return { files: 0, changed: 0, nodesRemoved: 0, classesSaved: 0, bytesSaved: 0 };
}

export function addStats(totals: Totals, stats: FileStats, changed: boolean): void {
  totals.files += 1;
  if (changed) totals.changed += 1;
  totals.nodesRemoved += stats.nodesRemoved;
  totals.classesSaved += stats.classesSaved;
  totals.bytesSaved += stats.bytesSaved;
}

/* ───────────────────────── worker-count planning ───────────────────────── */

export interface PoolPlan {
  /** Number of workers to spawn. */
  readonly workers: number;
  /** Effective memory budget in MB. */
  readonly budgetMB: number;
  /** Per-worker V8 old-generation cap in MB. */
  readonly perWorkerCapMB: number;
}

/** Clamp helper. */
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Compute the worker count + memory caps from the machine and the user's flags. `--concurrency` caps
 * the count directly; `--max-memory` (or ~70% of free RAM) both sets the budget AND, via
 * {@link PER_WORKER_MB}, limits how many workers fit — so memory always has the final say.
 */
export function computeWorkerCount(options: CliOptions): PoolPlan {
  const cpus = Math.max(1, os.cpus().length);
  const freeMB = Math.floor(os.freemem() / (1024 * 1024));
  const budgetMB = Math.max(PER_WORKER_MB, options.maxMemory ?? Math.floor(freeMB * 0.7));

  const byMemory = Math.max(1, Math.floor(budgetMB / PER_WORKER_MB));
  const target = options.concurrency ?? Math.max(1, cpus - 1);
  const workers = clamp(Math.min(target, byMemory), 1, byMemory);

  const perWorkerCapMB = Math.max(MIN_OLD_GEN_MB, Math.floor(budgetMB / workers));
  return { workers, budgetMB, perWorkerCapMB };
}

/** The batch is worth the pool only above this size; smaller jobs run inline. */
export function inlineThreshold(workers: number): number {
  return Math.max(4, 2 * workers);
}

/** True when the caller should use the pool (enough files AND more than one worker). */
export function shouldUsePool(fileCount: number, plan: PoolPlan): boolean {
  return plan.workers > 1 && fileCount > inlineThreshold(plan.workers);
}

/* ───────────────────────── worker resolution ───────────────────────── */

/** The directory of THIS module at runtime (CJS bundle via tsup shim, or ESM). */
function moduleDir(): string {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    // Extremely defensive — a CJS runtime without the shim would still have __dirname.
    return typeof __dirname !== 'undefined' ? __dirname : process.cwd();
  }
}

/**
 * Locate the built worker entry. It lives NEXT TO this module in a real build (`packages/cli/dist` and,
 * when bundled into `domflax`, `domflax/dist`); when running from source (vitest), it falls back to the
 * sibling `../dist`. `.cjs` is preferred (the bins are CJS), then `.js`.
 */
export function resolveWorkerPath(): string {
  const dir = moduleDir();
  const candidates = [
    path.join(dir, 'worker.cjs'),
    path.join(dir, 'worker.js'),
    path.join(dir, '..', 'dist', 'worker.cjs'),
    path.join(dir, '..', 'dist', 'worker.js'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Last resort: assume a sibling worker.cjs (surfaces a clear Worker load error if truly missing).
  return candidates[0]!;
}

/* ───────────────────────── message protocol ───────────────────────── */

/** main → worker. */
export type MainToWorker = { readonly type: 'file'; readonly path: string } | { readonly type: 'stop' };

/** worker → main. */
export type WorkerToMain =
  | { readonly type: 'ready' }
  | {
      readonly type: 'result';
      readonly path: string;
      readonly ok: true;
      readonly stats: FileStats;
      readonly changed: boolean;
      readonly wrote: string | null;
    }
  | { readonly type: 'result'; readonly path: string; readonly ok: false; readonly error: string };

/** Data handed to each worker at construction (structured-clone safe). */
export interface WorkerInit {
  readonly options: CliOptions;
  readonly inputRoot: string;
  readonly plan: WritePlan;
}

/* ───────────────────────── the pool ───────────────────────── */

export interface PoolOutcome {
  readonly totals: Totals;
  readonly failures: number;
  /** Absolute destination paths written, for a deterministic (sorted) post-run listing. */
  readonly wrote: readonly string[];
  /** Per-file error messages (path + reason), for reporting. */
  readonly errors: readonly { readonly path: string; readonly error: string }[];
}

interface Handle {
  worker: Worker;
  /** The file this worker is currently processing, or null when idle/stopping. */
  current: string | null;
  /** Set once the worker has replied 'ready' (engine built). */
  ready: boolean;
  dead: boolean;
}

/**
 * Run the pool over `files`, writing results per the shared {@link WritePlan}. Resolves once every file
 * is accounted for (optimized OR failed). Never rejects — worker deaths are recovered internally.
 */
export function runPool(
  files: readonly string[],
  init: WorkerInit,
  plan: PoolPlan,
  onWrote?: (dest: string) => void,
): Promise<PoolOutcome> {
  const workerPath = resolveWorkerPath();
  const totals = emptyTotals();
  const wrote: string[] = [];
  const errors: { path: string; error: string }[] = [];
  let failures = 0;

  const budgetBytes = plan.budgetMB * 1024 * 1024;
  let nextIndex = 0;
  let completed = 0;
  const total = files.length;

  // Respawn budget: guarantees termination. A worker that keeps dying (e.g. a memory cap too small to
  // even build the engine) can never spin forever — once the cap is hit, all remaining files are
  // failed and the pool finishes. Generous enough for the normal one-crash-per-bad-file case.
  let respawns = 0;
  const maxRespawns = total + plan.workers + 8;

  return new Promise<PoolOutcome>((resolve) => {
    const handles = new Set<Handle>();

    const finishIfDone = (): void => {
      if (completed < total) return;
      for (const h of handles) {
        if (!h.dead) {
          try {
            h.worker.postMessage({ type: 'stop' } satisfies MainToWorker);
          } catch {
            /* already gone */
          }
          void h.worker.terminate();
        }
      }
      handles.clear();
      resolve({ totals, failures, wrote, errors });
    };

    const recordFailure = (file: string, error: string): void => {
      failures += 1;
      completed += 1;
      errors.push({ path: file, error });
    };

    /** Hand the next file to an idle worker, or tell it to stop. Applies RSS backpressure. */
    const dispatch = (h: Handle): void => {
      if (h.dead) return;
      if (nextIndex >= total) {
        h.current = null;
        try {
          h.worker.postMessage({ type: 'stop' } satisfies MainToWorker);
        } catch {
          /* ignore */
        }
        return;
      }
      // Backpressure: if resident memory is near the budget, defer briefly (safety net atop the
      // static per-worker cap). Never blocks forever — it retries the SAME idle worker.
      if (process.memoryUsage().rss > budgetBytes) {
        setTimeout(() => dispatch(h), 25);
        return;
      }
      const file = files[nextIndex++]!;
      h.current = file;
      try {
        h.worker.postMessage({ type: 'file', path: file } satisfies MainToWorker);
      } catch {
        // Posting failed → treat as a worker death on this file.
        onWorkerDown(h);
      }
    };

    const onMessage = (h: Handle, msg: WorkerToMain): void => {
      if (msg.type === 'ready') {
        h.ready = true;
        dispatch(h);
        return;
      }
      // A result for the in-flight file.
      h.current = null;
      if (msg.ok) {
        addStats(totals, msg.stats, msg.changed);
        if (msg.wrote) {
          wrote.push(msg.wrote);
          onWrote?.(msg.wrote);
        }
      } else {
        failures += 1;
        errors.push({ path: msg.path, error: msg.error });
      }
      completed += 1;
      if (completed >= total) {
        finishIfDone();
        return;
      }
      dispatch(h);
    };

    /** Fail every not-yet-dispatched file, then finish — the terminal drain when we give up respawning. */
    const drainRemaining = (reason: string): void => {
      while (nextIndex < total) recordFailure(files[nextIndex++]!, reason);
      finishIfDone();
    };

    /** A worker crashed/exited unexpectedly while (possibly) holding a file: fail it, then respawn. */
    const onWorkerDown = (h: Handle): void => {
      if (h.dead) return;
      h.dead = true;
      handles.delete(h);
      const lost = h.current;
      h.current = null;
      if (lost !== null) recordFailure(lost, 'worker crashed while processing this file');

      void h.worker.terminate();

      if (completed >= total) {
        finishIfDone();
        return;
      }
      if (nextIndex >= total) {
        // No work left to hand out; only finish once every in-flight worker has drained.
        if (handles.size === 0) finishIfDone();
        return;
      }
      // Still work to do — respawn a replacement, unless we've exhausted the respawn budget (a memory
      // cap so small the worker can't even start): then fail the rest rather than loop forever.
      if (respawns < maxRespawns) {
        respawns += 1;
        spawn();
      } else if (handles.size === 0) {
        drainRemaining('worker pool exhausted its respawn budget (memory cap too small?)');
      }
    };

    const spawn = (): void => {
      let worker: Worker;
      try {
        worker = new Worker(workerPath, {
          workerData: init satisfies WorkerInit,
          resourceLimits: { maxOldGenerationSizeMb: plan.perWorkerCapMB },
        });
      } catch {
        // Cannot even construct a worker — if any file remains, fail one to guarantee progress.
        if (nextIndex < total) recordFailure(files[nextIndex++]!, 'failed to spawn worker');
        if (completed >= total) finishIfDone();
        else if (handles.size === 0 && nextIndex < total) spawn();
        return;
      }
      const h: Handle = { worker, current: null, ready: false, dead: false };
      handles.add(h);
      worker.on('message', (m: WorkerToMain) => onMessage(h, m));
      worker.on('error', () => onWorkerDown(h));
      worker.on('exit', (code) => {
        if (code !== 0) onWorkerDown(h);
      });
    };

    // Spawn the initial pool (never more workers than files).
    const initial = Math.min(plan.workers, total);
    for (let i = 0; i < initial; i++) spawn();
    if (initial === 0) finishIfDone();
  });
}
