/**
 * @domflax/cli — worker-thread body for the parallel pool (FEATURE B).
 *
 * Runs inside a `worker_threads` Worker. It builds ONE transform engine (reusing Feature A's per-file
 * resolver logic) from the {@link WorkerInit} handed over in `workerData`, then services one file at a
 * time on request from the main thread: read → transform → write to the planned destination → post
 * back only stats numbers. File contents never cross back to the main thread.
 *
 * Every file is wrapped in try/catch: a bad file fails in isolation (reported, pool continues) and can
 * never take the worker — or the whole run — down.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';

import { destinationFor } from './safety';
import { createTransform } from './transform';
import type { MainToWorker, WorkerInit, WorkerToMain } from './pool';

/** Start the worker message loop. A no-op on the main thread (import is side-effect-safe). */
export function runWorker(): void {
  if (isMainThread || !parentPort) return;
  const port = parentPort;
  const init = workerData as WorkerInit;
  const { inputRoot, plan } = init;

  // Build the engine ONCE per worker (this is the ~PER_WORKER_MB cost the pool provisions for).
  const transform = createTransform(init.options);

  const processOne = (file: string): void => {
    try {
      const code = readFileSync(file, 'utf8');
      const result = transform.transformFile(code, file);
      let wrote: string | null = null;
      // AUDIT mode never writes — the worker only reports the would-be stats back to the main thread.
      if (result.changed && init.options.audit !== true) {
        const target = destinationFor(file, inputRoot, plan);
        if (!target.ok) throw new Error(target.error);
        mkdirSync(path.dirname(target.value), { recursive: true });
        writeFileSync(target.value, result.code, 'utf8');
        wrote = target.value;
      }
      port.postMessage({
        type: 'result',
        path: file,
        ok: true,
        stats: result.stats,
        changed: result.changed,
        wrote,
      } satisfies WorkerToMain);
    } catch (err) {
      port.postMessage({
        type: 'result',
        path: file,
        ok: false,
        error: String((err as Error)?.message ?? err),
      } satisfies WorkerToMain);
    }
  };

  port.on('message', (msg: MainToWorker) => {
    if (msg.type === 'file') {
      processOne(msg.path);
      return;
    }
    if (msg.type === 'stop') {
      port.close();
      process.exit(0);
    }
  });

  // Signal the main thread the engine is built and we're ready for the first file.
  port.postMessage({ type: 'ready' } satisfies WorkerToMain);
}
