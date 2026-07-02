/**
 * @domflax/frontend-astro — `.astro` <-> IR frontend + backend.
 *
 * A {@link Frontend} that parses an Astro component into an {@link IRDocument} (frontmatter preserved
 * verbatim and never represented; template lowered via parse5 FRAGMENT parsing with the region offset
 * added to every span), and a matching {@link Backend} that prints the edited document back with
 * SURGICAL, span-based edits over the original source. Untouched bytes — frontmatter, components,
 * directives, `{expr}` islands, comments, whitespace, attribute order — stay byte-for-byte identical,
 * and a file containing any `<style>` block (scoped styles) passes through entirely unchanged.
 *
 * parse5 is a real dependency but is LAZILY required inside `parse()` (see `./parse`). The region
 * model lives in `./regions`, the opacity/span helpers in `./walk`, the reverse codegen in
 * `./backend`. This module is the public assembly point.
 */

import type {
  Backend,
  BackendContext,
  CodegenResult,
  EditPlan,
  Frontend,
  FrontendParseContext,
  IRDocument,
  ParseResult,
} from '@domflax/core';

import { doPrint } from './backend';
import { doParse } from './parse';
import { ASTRO_LANGS, looksLikeAstro } from './walk';

export { ASTRO_LANGS, looksLikeAstro } from './walk';
export { splitAstro, hasStyleBlock } from './regions';
export type { AstroSplit } from './regions';

/** Astro frontend: `.astro` → IR (frontmatter verbatim; template spans for surgical codegen). */
export const astroFrontend: Frontend = {
  name: 'astro',
  langs: ASTRO_LANGS,
  canParse(id: string, code: string): boolean {
    return looksLikeAstro(id, code);
  },
  parse(code: string, ctx: FrontendParseContext): ParseResult {
    return doParse(code, ctx);
  },
};

/** Factory mirror — returns a fresh handle to the (stateless) Astro frontend. */
export function createAstroFrontend(): Frontend {
  return astroFrontend;
}

/** Astro backend: IR → `.astro` via span-based surgical edits over the retained verbatim source. */
export const astroBackend: Backend = {
  name: 'astro',
  langs: ASTRO_LANGS,
  print(doc: IRDocument, _plan: EditPlan, _ctx: BackendContext): CodegenResult {
    return { code: doPrint(doc), map: null, edits: [], diagnostics: [] };
  },
};

/** Factory mirror — returns a fresh handle to the (stateless) Astro backend. */
export function createAstroBackend(): Backend {
  return astroBackend;
}

export default astroFrontend;
