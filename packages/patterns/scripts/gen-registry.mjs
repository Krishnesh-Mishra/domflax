// @ts-check
/**
 * Build-time codegen for `@domflax/patterns`.
 *
 * Discovers every `src/**\/*.pattern.ts` file by convention, validates that each default- or
 * named-exports exactly one valid {@link Pattern}, asserts pattern `name`s are unique, then writes
 * `src/_registry.generated.ts` with explicit imports + an assembled `builtinPatterns` array sorted
 * by category phase (all `flatten/*` before `compress/*`, stable by file path within a phase).
 *
 * The generated file is a BUILD ARTIFACT (gitignored). It is regenerated before typecheck, build,
 * and test so tsc/vitest always see an up-to-date registry. Adding a pattern is now a single file:
 * drop a `<name>.pattern.ts` under `src/library/flatten/` or `src/library/compress/` and re-run
 * `npm run generate`.
 *
 * Validation is done at runtime: each pattern module is bundled with esbuild (resolving the
 * workspace deps to their built dist) and imported so the `pattern()` factory actually executes and
 * its output shape can be checked. No assumptions about export identifiers are baked in.
 */

import { build } from 'esbuild';
import fg from 'fast-glob';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, '..');
const SRC = join(PKG_ROOT, 'src');
const OUT = join(SRC, '_registry.generated.ts');

/** Phase ordering for the assembled array: every `flatten/*` before every `compress/*`. */
const PHASE_ORDER = ['flatten', 'compress'];

/** @param {string} category */
function phaseOf(category) {
  return String(category).split('/', 1)[0] ?? '';
}

/** A runtime-shape check mirroring core's `Pattern` interface. */
function isPattern(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (/** @type {any} */ (value).name) === 'string' &&
    typeof (/** @type {any} */ (value).category) === 'string' &&
    typeof (/** @type {any} */ (value).safety) === 'number' &&
    typeof (/** @type {any} */ (value).evaluate) === 'function'
  );
}

/** Fail loudly with a clear, prefixed message. */
function fail(message) {
  console.error(`\n[gen-registry] ERROR: ${message}\n`);
  process.exit(1);
}

async function main() {
  // 1. DISCOVER — glob the pattern files (POSIX-style paths from fast-glob), deterministic order.
  const rel = (await fg('**/*.pattern.ts', { cwd: SRC })).sort();
  if (rel.length === 0) fail(`no \`*.pattern.ts\` files found under ${SRC}`);

  const files = rel.map((r) => ({
    rel: r,
    abs: join(SRC, r),
    // Module specifier used in the generated TS: extensionless, relative to src/ (Bundler res).
    spec: './' + r.replace(/\.ts$/, ''),
  }));

  // 2. LOAD — bundle a synthetic entry that namespace-imports every pattern file, then import it
  //    in-process so each `pattern(...)` call executes and we can inspect the real exports.
  const entry = files
    .map((f, i) => `import * as m${i} from ${JSON.stringify(f.abs.replace(/\\/g, '/'))};`)
    .join('\n') +
    `\nexport const mods = [${files.map((_, i) => `m${i}`).join(', ')}];\n`;

  const tmp = await mkdtemp(join(tmpdir(), 'domflax-genreg-'));
  const bundlePath = join(tmp, 'entry.mjs');
  let mods;
  try {
    await build({
      stdin: { contents: entry, resolveDir: SRC, sourcefile: 'entry.ts', loader: 'ts' },
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      outfile: bundlePath,
      logLevel: 'silent',
    });
    ({ mods } = await import(pathToFileURL(bundlePath).href));
  } catch (err) {
    fail(`failed to bundle/import pattern modules: ${err?.message ?? err}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  // 3. VALIDATE — exactly one valid Pattern export per file; remember its export identifier.
  /** @type {{ rel: string, spec: string, exportName: string, name: string, category: string }[]} */
  const entries = [];
  files.forEach((f, i) => {
    const ns = mods[i] ?? {};
    const hits = Object.entries(ns).filter(([, v]) => isPattern(v));
    if (hits.length === 0) {
      fail(
        `${f.rel} exports no valid Pattern. A *.pattern.ts file must default- or named-export a ` +
          `Pattern built with \`pattern()\` (needs string \`name\`/\`category\`, numeric \`safety\`, \`evaluate()\`).`,
      );
    }
    if (hits.length > 1) {
      fail(
        `${f.rel} exports ${hits.length} Patterns (${hits
          .map(([k]) => k)
          .join(', ')}); expected exactly one per file.`,
      );
    }
    const [exportName, pat] = hits[0];
    entries.push({
      rel: f.rel,
      spec: f.spec,
      exportName,
      name: /** @type {any} */ (pat).name,
      category: /** @type {any} */ (pat).category,
    });
  });

  // 4. UNIQUENESS — pattern `name`s must be globally unique.
  const byName = new Map();
  for (const e of entries) {
    const prev = byName.get(e.name);
    if (prev) fail(`duplicate pattern name "${e.name}" in ${prev.rel} and ${e.rel}`);
    byName.set(e.name, e);
  }

  // 5. SORT — by category phase (flatten before compress), stable by file path within a phase.
  entries.sort((a, b) => {
    const pa = PHASE_ORDER.indexOf(phaseOf(a.category));
    const pb = PHASE_ORDER.indexOf(phaseOf(b.category));
    const oa = pa === -1 ? PHASE_ORDER.length : pa;
    const ob = pb === -1 ? PHASE_ORDER.length : pb;
    if (oa !== ob) return oa - ob;
    return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
  });

  // 6. EMIT — explicit imports + named re-exports + the assembled array + default.
  const imports = entries
    .map((e) => `import { ${e.exportName} } from '${e.spec}';`)
    .join('\n');
  const reexports = entries.map((e) => `  ${e.exportName},`).join('\n');
  const array = entries.map((e) => `  ${e.exportName},`).join('\n');

  const banner =
    `/**\n` +
    ` * AUTO-GENERATED by \`scripts/gen-registry.mjs\` — DO NOT EDIT BY HAND.\n` +
    ` *\n` +
    ` * Regenerate with \`npm run generate\` (also runs automatically before build/typecheck/test).\n` +
    ` * Patterns are discovered by the \`*.pattern.ts\` file convention under \`src/library/flatten\`\n` +
    ` * and \`src/library/compress\`; the array below is sorted flatten-before-compress.\n` +
    ` */`;

  const code =
    `${banner}\n\n` +
    `import type { Pattern } from '@domflax/core';\n\n` +
    `${imports}\n\n` +
    `export {\n${reexports}\n};\n\n` +
    `/** Every built-in pattern, in registration order (flatten patterns before compress). */\n` +
    `export const builtinPatterns: readonly Pattern[] = [\n${array}\n];\n\n` +
    `export default builtinPatterns;\n`;

  await writeFile(OUT, code, 'utf8');
  console.log(
    `[gen-registry] wrote ${relative(PKG_ROOT, OUT)} with ${entries.length} patterns ` +
      `(${entries.map((e) => e.name).join(', ')}).`,
  );
}

main().catch((err) => fail(err?.stack ?? String(err)));
