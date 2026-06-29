/**
 * @domflax/pattern-kit — `definePattern`.
 *
 * A small, eager validator + identity wrapper that turns an author-supplied {@link Pattern} spec
 * into a frozen, contract-checked Pattern. Catching shape errors here (bad category/phase, missing
 * `evaluate`, out-of-range safety) keeps the pass-manager's hot loop free of defensive checks and
 * gives authors an immediate, actionable error at module-load time.
 */

import type { PassPhase, Pattern, SafetyLevel } from '@domflax/core';

const PHASES: ReadonlySet<PassPhase> = new Set<PassPhase>(['flatten', 'compress', 'extract']);
const SAFETY_LEVELS: ReadonlySet<SafetyLevel> = new Set<SafetyLevel>([0, 1, 2, 3]);

function fail(name: string, why: string): never {
  throw new Error(`definePattern(${name || '<anonymous>'}): ${why}`);
}

/**
 * Validate and freeze a {@link Pattern}. Throws on any contract violation; otherwise returns the
 * (shallow-frozen) spec unchanged so it can be registered into a {@link Pass}.
 */
export function definePattern(spec: Pattern): Pattern {
  if (spec == null || typeof spec !== 'object') {
    throw new Error('definePattern: spec must be an object');
  }

  const name = spec.name;
  if (typeof name !== 'string' || name.length === 0) {
    fail(String(name), 'name must be a non-empty string');
  }

  if (typeof spec.category !== 'string' || !spec.category.includes('/')) {
    fail(name, `category must be a "<phase>/<slug>" string (got ${JSON.stringify(spec.category)})`);
  }

  const phase = spec.category.split('/', 1)[0] as PassPhase;
  if (!PHASES.has(phase)) {
    fail(name, `category phase must be one of flatten|compress|extract (got "${phase}")`);
  }

  if (!SAFETY_LEVELS.has(spec.safety)) {
    fail(name, `safety must be 0|1|2|3 (got ${JSON.stringify(spec.safety)})`);
  }

  if (typeof spec.evaluate !== 'function') {
    fail(name, 'evaluate must be a function');
  }

  if (spec.priority !== undefined && !Number.isFinite(spec.priority)) {
    fail(name, 'priority must be a finite number when provided');
  }

  return Object.freeze({ ...spec });
}
