/**
 * @domflax/frontend-vue — Vue SFC (`.vue`) <-> IR frontend + backend, TEMPLATE BLOCK ONLY.
 *
 * A {@link Frontend} that parses a `.vue` single-file component with `@vue/compiler-sfc` (lazily
 * loaded — it is an OPTIONAL peer; when unavailable `canParse` is false and `parse` degrades to a
 * byte-identical passthrough, never throwing) and lowers ONLY the `<template>` block into an
 * {@link IRDocument} with precise whole-file source spans; and a matching {@link Backend} that prints
 * the edited document back with SURGICAL, span-based edits over the original source. `<script>` and
 * `<style>` blocks are never represented, so they are preserved verbatim by construction — and any
 * `<style>` block at all (scoped, module, or plain) switches the whole file to passthrough.
 *
 * Conservative opacity: directives (`v-*`/`:`/`@`/`#`), component tags, `<slot>`, nested
 * `<template>`, and `{{ interpolation }}` islands are never optimized — see `./parse` / `./opacity`.
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
import { loadCompilerSfc, looksLikeVue, VUE_LANGS } from './sfc';

export { looksLikeVue, VUE_LANGS, __setCompilerSfcLoaderForTests } from './sfc';
export type { CompilerSfcModule } from './sfc';

/** Vue SFC frontend: `<template>` → IR (with whole-file source spans for surgical codegen). */
export const vueFrontend: Frontend = {
  name: 'vue',
  langs: VUE_LANGS,
  canParse(id: string, _code: string): boolean {
    // Only `.vue` files, and only when the OPTIONAL `@vue/compiler-sfc` peer actually loads.
    return looksLikeVue(id) && loadCompilerSfc() != null;
  },
  parse(code: string, ctx: FrontendParseContext): ParseResult {
    return doParse(code, ctx);
  },
};

/** Factory mirror — returns a fresh handle to the (stateless) Vue frontend. */
export function createVueFrontend(): Frontend {
  return vueFrontend;
}

/** Vue SFC backend: IR → `.vue` via span-based surgical edits over the retained verbatim source. */
export const vueBackend: Backend = {
  name: 'vue',
  langs: VUE_LANGS,
  print(doc: IRDocument, _plan: EditPlan, _ctx: BackendContext): CodegenResult {
    return { code: doPrint(doc), map: null, edits: [], diagnostics: [] };
  },
};

/** Factory mirror — returns a fresh handle to the (stateless) Vue backend. */
export function createVueBackend(): Backend {
  return vueBackend;
}

export default vueFrontend;
