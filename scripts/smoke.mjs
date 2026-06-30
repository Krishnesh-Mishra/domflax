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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

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

// 0) REAL MODULE round-trip — the regression that hid the destructive backend. The built dist must
//    transform a COMPLETE module (imports + `export default function` + hooks + `return (…)` +
//    `{title}` hole) WITHOUT dropping any surrounding code, while still flattening + compressing.
{
  const code = [
    "import React from 'react';",
    '',
    'export default function Card({ title }) {',
    '  return (',
    '    <div className="w-full h-full flex justify-center items-center">',
    '      <div className="px-4 py-4 bg-white">{title}</div>',
    '    </div>',
    '  );',
    '}',
    '',
  ].join('\n');
  const { code: out } = createDomflax().transform(code, 'Card.tsx');
  console.log('  [real-module] out:\n' + out);
  // Surrounding module survives byte-regions intact.
  check('real module kept import', out.includes("import React from 'react';"));
  check('real module kept `export default function Card`', out.includes('export default function Card({ title })'));
  check('real module kept the return statement', out.includes('return ('));
  check('real module kept the {title} hole', out.includes('{title}'));
  // CONSERVATIVE DEFAULT (verify off): the flex-centering wrapper is a `needs-verification` flatten,
  // so it is PRESERVED — domflax never changes rendering by default. The `{title}` div has a dynamic
  // child, so it is NOT flattened — but its OWN class tokens still COMPRESS (px-4 py-4 → p-4): a
  // class-only rewrite is unaffected by a dynamic child.
  check('real module PRESERVED the flex wrapper (conservative default)', out.includes('justify-center'));
  check('real module did NOT push place-self-center (verify off)', !out.includes('place-self-center'));
  check('real module COMPRESSED dynamic-child div (px-4 py-4 → p-4)', out.includes('p-4') && !out.includes('px-4') && !out.includes('py-4'));
  check('real module kept bg-white', out.includes('bg-white'));
  // The output is a complete module — re-transforming it must not throw.
  let reok = true;
  try { createDomflax().transform(out, 'Card.tsx'); } catch { reok = false; }
  check('real module output is itself a valid module (re-transforms cleanly)', reok);
}

// 1) Flex-centering wrapper is PRESERVED by default (needs-verification), but the child still
//    compresses (compress is independent of the flatten gate): h-10 w-10 → size-10.
{
  const code =
    '<div className="w-full h-full flex justify-center items-center">' +
    '<div className="h-10 w-10 bg-red-200">Hello</div>' +
    '</div>';
  const { code: out } = createDomflax().transform(code, 'App.tsx');
  console.log('  [flex-center] out:', out);
  check('wrapper PRESERVED (justify-center kept, no rendering change)', out.includes('justify-center'));
  check('no place-self-center pushed (verify off is conservative)', !out.includes('place-self-center'));
  check('child kept bg-red-200', out.includes('bg-red-200'));
  check('kept text content', out.includes('Hello'));
  // The child's equal width/height (`h-10 w-10`) still compresses to the shorter `size-10`.
  check('COMPRESS shortened h-10 w-10 → size-10 in built dist', out.includes('size-10') && !out.includes('h-10') && !out.includes('w-10'));
}

// 1a) A PROVABLY-SAFE flatten (display:contents wrapper contributes nothing) IS applied by default.
{
  const code = '<div className="contents"><a className="text-blue-500">L</a></div>';
  const { code: out } = createDomflax().transform(code, 'App.tsx');
  console.log('  [provably-safe contents] out:', out);
  check('provably-safe flatten applied (contents wrapper removed)', !out.includes('contents'));
  check('provably-safe flatten kept the child', out.includes('text-blue-500'));
}

// 1b-static) The transform is SYNC + browser-free: no async/close surface is exposed.
{
  const engine = createDomflax();
  check('built dist transform is sync (returns a result object, not a Promise)', typeof engine.transform === 'function' && !(engine.transform('<div/>', 'App.tsx') instanceof Promise));
  check('built dist does NOT expose transformAsync (static-only)', typeof engine.transformAsync === 'undefined');
  check('built dist does NOT expose close (no browser to release)', typeof engine.close === 'undefined');
}

// 1b) COMPRESS actually shortens output end-to-end in the built dist: px-4 py-4 → p-4.
{
  const code = '<div className="px-4 py-4 bg-white">x</div>';
  const { code: out } = createDomflax().transform(code, 'App.tsx');
  console.log('  [compress px/py] out:', out);
  check('px-4 py-4 collapsed to p-4', out.includes('p-4'));
  check('no leftover px-4', !out.includes('px-4'));
  check('no leftover py-4', !out.includes('py-4'));
  check('preserved bg-white', out.includes('bg-white'));
}

// 1c) COMPRESS fires on an element with a DYNAMIC child (the real-app common case): a class-only
//     rewrite cannot affect the child, so `{x}` must not block px-4 py-4 → p-4.
{
  const code = '<div className="px-4 py-4">{x}</div>';
  const { code: out } = createDomflax().transform(code, 'App.tsx');
  console.log('  [compress dynamic-child] out:', out);
  check('dynamic-child px-4 py-4 collapsed to p-4', out.includes('p-4') && !out.includes('px-4') && !out.includes('py-4'));
  check('dynamic child {x} preserved', out.includes('{x}'));
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

// 4) T5 — custom-CSS provider: a flex-centering wrapper whose `place-self:center` is NOT reproducible
//    by the project CSS must be PRESERVED (centering would otherwise be silently dropped). The
//    Tailwind case above (#0/#1) already proves the emittable side still flattens.
// 5) T4 — custom-CSS provider: wrappers a combinator/descendant selector depends on are PRESERVED.
{
  const tmp = mkdtempSync(path.join(tmpdir(), 'domflax-smoke-'));
  try {
    const centerCss = path.join(tmp, 'center.css');
    writeFileSync(
      centerCss,
      '.center{display:flex;align-items:center;justify-content:center}\n.card{background:#fff}\n',
    );
    const codeT5 =
      'export default function B(){return (<div className="center"><div className="card">{y}</div></div>);}';
    const outT5 = createDomflax({ provider: 'custom', cssFiles: [centerCss] }).transform(codeT5, 'B.tsx').code;
    console.log('  [T5 custom] out:', outT5);
    check('T5: .center wrapper PRESERVED (un-emittable place-self-center not dropped)', outT5.includes('className="center"'));
    check('T5: .card child preserved', outT5.includes('className="card"'));

    const combinatorCss = path.join(tmp, 'combinator.css');
    writeFileSync(
      combinatorCss,
      '.list > .item h3 { color: red }\n.item { display:flex; align-items:center; justify-content:center }\n',
    );
    const codeT4 = '<div className="list"><div className="item"><span className="x">{a}</span></div></div>';
    const outT4 = createDomflax({ provider: 'custom', cssFiles: [combinatorCss] }).transform(codeT4, 'C.tsx').code;
    console.log('  [T4 custom] out:', outT4);
    check('T4: .list wrapper PRESERVED (combinator dependent)', outT4.includes('className="list"'));
    check('T4: .item wrapper PRESERVED (combinator dependent)', outT4.includes('className="item"'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// 6) T7 — the default export is an object exposing { createDomflax, vite, webpack } and the build
//    adapters return valid plugin shapes (works through the built dist / CJS `require`).
{
  const def = domflax.default ?? domflax;
  console.log('  [T7 default keys]', Object.keys(def));
  check('T7: default.createDomflax is a function', typeof def.createDomflax === 'function');
  check('T7: default.vite is a function', typeof def.vite === 'function');
  check('T7: default.webpack is a function', typeof def.webpack === 'function');
  const vitePlugin = def.vite();
  check('T7: vite() yields { name:"domflax", enforce:"pre", transform }', vitePlugin.name === 'domflax' && vitePlugin.enforce === 'pre' && typeof vitePlugin.transform === 'function');
  const wpPlugin = def.webpack();
  check('T7: webpack() yields { name:"domflax", apply }', wpPlugin.name === 'domflax' && typeof wpPlugin.apply === 'function');
}

// 7) T6 — webpack().apply must accept BOTH a real Compiler (`.options.module`) and Next's bare
//    config (`.module`) without throwing, pushing a `.jsx/.tsx` loader rule in each shape.
{
  const compiler = { options: { module: { rules: [] } } };
  let compilerOk = true;
  try { domflax.webpack({}).apply(compiler); } catch { compilerOk = false; }
  check('T6: apply(real Compiler {options:{module:{rules}}}) pushed a rule', compilerOk && compiler.options.module.rules.length === 1);

  const bare = { module: { rules: [] } };
  let bareOk = true;
  try { domflax.webpack({}).apply(bare); } catch (err) { bareOk = false; console.error(err); }
  check('T6: apply(Next bare config {module:{rules}}) did not throw and pushed a rule', bareOk && bare.module.rules.length === 1);
  if (bareOk) {
    const rule = bare.module.rules[0];
    check('T6: bare-config rule is pre-enforced and matches .tsx', rule.enforce === 'pre' && rule.test.test('App.tsx'));
  }
}

// 8) CLI bin must execute EXACTLY ONCE. A bundled self-invocation in @domflax/cli
//    previously ran the whole CLI twice (every prompt/message duplicated).
{
  const { spawnSync } = await import('node:child_process');
  const cliBin = path.join(here, '..', 'packages', 'domflax', 'dist', 'cli.cjs');
  const res = spawnSync(process.execPath, [cliBin], { input: '', encoding: 'utf8' });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const runs = (out.match(/no input paths/g) || []).length;
  check('CLI bin executes exactly once (no double-invocation)', runs === 1);
}

// 9) STATIC-ONLY: the user transform entry (index.cjs) must be browser-free — it must neither bundle
//    nor require playwright / @domflax/verify. Asserts against the built file's contents.
{
  const { readFileSync } = await import('node:fs');
  const idxSrc = readFileSync(distEntry, 'utf8');
  check('index.cjs does not reference playwright', !/playwright/i.test(idxSrc));
  check('index.cjs does not reference chromium', !/chromium/i.test(idxSrc));
  check('index.cjs does not require @domflax/verify', !/@domflax\/verify/.test(idxSrc));
  check('index.cjs has no browser-launch hook', !/launchBrowser|verifyEquivalence|createFlattenVerifier/.test(idxSrc));
  // The cli.cjs bundled into the published package must likewise be browser-free.
  const cliSrc = readFileSync(path.join(here, '..', 'packages', 'domflax', 'dist', 'cli.cjs'), 'utf8');
  check('cli.cjs does not reference playwright', !/playwright/i.test(cliSrc));
  check('cli.cjs does not require @domflax/verify', !/@domflax\/verify/.test(cliSrc));
}

if (failures.length > 0) {
  console.error(`\nSMOKE FAIL: ${failures.length} assertion(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\nSMOKE PASS: built dist is conservative by default (no rendering change), applies provably-safe flattens, compresses, and respects the onClick barrier.');
