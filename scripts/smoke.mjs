/**
 * Dist-level smoke test — guards against source-vs-dist divergence.
 *
 * The bug this protects against: domflax bundles `@domflax/*` (incl. the Tailwind/CSS resolvers)
 * into its own `dist` via tsup `noExternal`. The resolvers load their heavy engines (tailwindcss v3,
 * postcss) through `createRequire`. If that require is rooted at the BUNDLE'S location instead of the
 * consumer's project, the engine fails to load when inlined into `domflax/dist` and the reverse
 * `emit` step silently produces nothing — so a transform that works in source/vitest loses
 * `place-self-center` in the built package. The unit/e2e suites run against SOURCE and cannot catch
 * this; this script asserts against the actual BUILT `packages/domflax/dist/index.cjs`.
 *
 * Run via `npm run smoke` (which builds first). Exits non-zero on any failed assertion.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.join(here, '..', 'packages', 'domflax', 'dist', 'index.cjs');

const require = createRequire(import.meta.url);
let domflax;
try {
  domflax = require(distEntry);
} catch (err) {
  console.error(`SMOKE FAIL: cannot require built dist at ${distEntry}`);
  console.error(err);
  process.exit(1);
}

const { createDomflax } = domflax;
if (typeof createDomflax !== 'function') {
  console.error('SMOKE FAIL: built dist does not export createDomflax');
  process.exit(1);
}

const failures = [];
const check = (label, cond) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!cond) failures.push(label);
};

// 1) Flex-centering wrapper flattens AND the centering intent survives as place-self-center.
{
  const code =
    '<div className="w-full h-full flex justify-center items-center">' +
    '<div className="h-10 w-10 bg-red-200">Hello</div>' +
    '</div>';
  const { code: out } = createDomflax().transform(code, 'App.tsx');
  console.log('  [flex-center] out:', out);
  check('wrapper flattened (no justify-center)', !out.includes('justify-center'));
  check('child kept bg-red-200', out.includes('bg-red-200'));
  check('REVERSE-EMIT produced place-self-center (the regression)', out.includes('place-self-center'));
  check('kept text content', out.includes('Hello'));
}

// 2) An onClick wrapper is an opacity barrier — it must NOT flatten.
{
  const code =
    '<div className="w-full h-full flex justify-center items-center" onClick={handleClick}>' +
    '<div className="h-10 w-10 bg-red-200">Hello</div>' +
    '</div>';
  const { code: out } = createDomflax().transform(code, 'App.tsx');
  console.log('  [onClick] out:', out);
  check('onClick wrapper preserved', out.includes('onClick={handleClick}'));
  check('onClick wrapper kept its classes', out.includes('justify-center'));
  check('no place-self-center pushed through barrier', !out.includes('place-self-center'));
}

// 3) The Tailwind engine actually loaded from the project (not the silent fallback).
{
  const provider = createDomflax().resolver.provider;
  console.log('  [provider]', provider);
  check('Tailwind engine loaded (provider is versioned, not bare fallback)', /^tailwindcss@\d/.test(provider));
}

if (failures.length > 0) {
  console.error(`\nSMOKE FAIL: ${failures.length} assertion(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\nSMOKE PASS: built dist transform yields place-self-center and respects the onClick barrier.');
