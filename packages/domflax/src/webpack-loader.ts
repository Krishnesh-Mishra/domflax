/**
 * domflax webpack loader.
 *
 * A genuine webpack loader module: webpack requires this file by absolute path (wired by the
 * `domflax.webpack()` plugin, see {@link ./index.webpack}) and invokes the default export once per
 * matched `.jsx`/`.tsx` module. It runs the SAME single-file engine as {@link createDomflax} — so the
 * heavy Tailwind/postcss engines stay LAZY (constructed on first transform, only for the selected
 * provider), exactly as in the Vite adapter and the programmatic API.
 *
 * The loader is intentionally synchronous (the transform is a pure CPU function with no source map
 * yet) and structurally typed against webpack: it depends only on a minimal local `LoaderContext`
 * shape, never on the `webpack` package itself.
 */
import { createDomflax } from './index';
import type { Domflax, DomflaxOptions } from './index';

/**
 * The slice of webpack's `LoaderContext` the domflax loader touches. Declared locally so this module
 * does not hard-depend on `webpack` types.
 */
export interface DomflaxLoaderContext {
  /** Absolute path of the module being transformed (no query suffix). */
  readonly resourcePath: string;
  /** Loader options passed via the `module.rule` `use[].options` entry. */
  getOptions?(): DomflaxOptions | undefined;
}

/**
 * Engine cache keyed by the serialized options, so a build reuses one configured engine (and its
 * one lazily-loaded resolver) across every transformed file instead of rebuilding per module.
 */
const engines = new Map<string, Domflax>();

function engineFor(options: DomflaxOptions): Domflax {
  const key = JSON.stringify(options ?? {});
  let engine = engines.get(key);
  if (!engine) {
    engine = createDomflax(options);
    engines.set(key, engine);
  }
  return engine;
}

/**
 * webpack loader entry point. Returns the (possibly rewritten) source; non-jsx/tsx or unchanged
 * modules round-trip through {@link Domflax.transform} unchanged.
 */
export default function domflaxLoader(this: DomflaxLoaderContext, source: string): string {
  const options = this.getOptions?.() ?? {};
  const engine = engineFor(options);
  return engine.transform(source, this.resourcePath).code;
}
