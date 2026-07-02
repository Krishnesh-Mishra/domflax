/**
 * @domflax/frontend-vue — lazy `@vue/compiler-sfc` interop + the minimal SFC shapes this frontend reads.
 *
 * `@vue/compiler-sfc` is an OPTIONAL peer dependency: it is loaded LAZILY (via `createRequire`, since
 * {@link Frontend.parse} is synchronous) the first time the frontend needs it, and a missing/broken
 * install NEVER throws — `loadCompilerSfc()` returns null, `canParse` reports false, and `parse`
 * degrades to a byte-identical passthrough. The compiler ships its own types, but because it is
 * required lazily as `unknown` this module re-declares ONLY the slice the frontend touches.
 *
 * No document mutation, no third-party imports — only the `@domflax/core` type contract.
 */

import { createRequire } from 'node:module';

import type { FileKind, SourceFileId, SourceSpan } from '@domflax/core';

/**
 * Languages this frontend claims. `@domflax/core` has no dedicated `.vue` {@link FileKind} yet, and
 * the HTML kind is owned by the sibling HTML frontend — so this frontend claims `unknown` and gates
 * ownership on `canParse` (the `.vue` extension + compiler availability).
 */
export const VUE_LANGS: readonly FileKind[] = ['unknown'];

/** The single registered source file id (one parse == one SFC). */
export const FILE_ID = 1 as SourceFileId;

/** Lightweight heuristic: is this source id a Vue single-file component? */
export function looksLikeVue(id: string): boolean {
  return /\.vue$/i.test(id.split(/[?#]/, 1)[0] ?? id);
}

/** A {@link SourceSpan} over `[start, end)` in the single source file. */
export function span(start: number, end: number): SourceSpan {
  return { file: FILE_ID, start, end };
}

/* ───────────────────────── @vue/compiler-sfc minimal shapes (lazy-required as unknown) ───────────────────────── */

export interface SfcPosition {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

/** A compiler-sfc / compiler-core source location: absolute offsets into the WHOLE `.vue` file. */
export interface SfcLoc {
  readonly start: SfcPosition;
  readonly end: SfcPosition;
  readonly source: string;
}

/** A generic SFC block (`<script>` / `<style>` / custom). Only the fields the frontend reads. */
export interface SfcBlock {
  readonly type: string;
  readonly content: string;
  readonly loc: SfcLoc;
  readonly lang?: string;
  readonly src?: string;
}

export interface SfcStyleBlock extends SfcBlock {
  readonly scoped?: boolean;
  readonly module?: string | boolean;
}

export interface SfcTemplateBlock extends SfcBlock {
  /** The compiler-core template AST (node `loc` offsets are absolute into the whole file). */
  readonly ast?: TplRootNode | null;
}

export interface SfcDescriptor {
  readonly template: SfcTemplateBlock | null;
  readonly script: SfcBlock | null;
  readonly scriptSetup: SfcBlock | null;
  readonly styles: readonly SfcStyleBlock[];
}

export interface SfcParseResult {
  readonly descriptor: SfcDescriptor;
  readonly errors: readonly unknown[];
}

/** The tiny slice of the `@vue/compiler-sfc` module surface the frontend calls. */
export interface CompilerSfcModule {
  parse(
    source: string,
    options?: {
      readonly filename?: string;
      readonly sourceMap?: boolean;
      readonly templateParseOptions?: Readonly<Record<string, unknown>>;
    },
  ): SfcParseResult;
}

/* ───────────────────────── compiler-core template AST minimal shapes ───────────────────────── */

/** `NodeTypes` discriminants (compiler-core) — only the ones the un-transformed parse AST contains. */
export const TPL = {
  ROOT: 0,
  ELEMENT: 1,
  TEXT: 2,
  COMMENT: 3,
  INTERPOLATION: 5,
  ATTRIBUTE: 6,
  DIRECTIVE: 7,
} as const;

/** `ElementTypes` discriminants — PLAIN html element vs component / `<slot>` / nested `<template>`. */
export const TPL_TAG = { ELEMENT: 0, COMPONENT: 1, SLOT: 2, TEMPLATE: 3 } as const;

export interface TplAttributeNode {
  readonly type: typeof TPL.ATTRIBUTE;
  readonly name: string;
  readonly value?: { readonly content: string; readonly loc: SfcLoc } | undefined;
  readonly loc: SfcLoc;
}

export interface TplDirectiveNode {
  readonly type: typeof TPL.DIRECTIVE;
  readonly name: string; // 'if' | 'for' | 'bind' | 'on' | 'slot' | 'model' | ...
  readonly loc: SfcLoc;
}

export type TplProp = TplAttributeNode | TplDirectiveNode;

export interface TplElementNode {
  readonly type: typeof TPL.ELEMENT;
  readonly ns: number; // 0 = HTML
  readonly tag: string;
  readonly tagType: number; // TPL_TAG.*
  readonly props: readonly TplProp[];
  readonly children: readonly TplChildNode[];
  readonly isSelfClosing?: boolean;
  readonly loc: SfcLoc;
}

export interface TplTextNode {
  readonly type: typeof TPL.TEXT;
  readonly content: string;
  readonly loc: SfcLoc;
}

export interface TplCommentNode {
  readonly type: typeof TPL.COMMENT;
  readonly content: string;
  readonly loc: SfcLoc;
}

export interface TplInterpolationNode {
  readonly type: typeof TPL.INTERPOLATION;
  readonly loc: SfcLoc;
}

/** Anything else the parser could conceivably emit — handled conservatively (preserved verbatim). */
export interface TplUnknownNode {
  readonly type: number;
  readonly loc?: SfcLoc;
}

export type TplChildNode =
  | TplElementNode
  | TplTextNode
  | TplCommentNode
  | TplInterpolationNode
  | TplUnknownNode;

export interface TplRootNode {
  readonly type: typeof TPL.ROOT;
  readonly children: readonly TplChildNode[];
}

/* ───────────────────────── lazy loader (+ test seam) ───────────────────────── */

let cached: CompilerSfcModule | null | undefined; // undefined = not yet attempted
let loaderOverride: (() => CompilerSfcModule) | null = null;

function defaultLoad(): CompilerSfcModule {
  // `createRequire` (NOT a top-level import): parse() is synchronous and the peer is optional, so the
  // module must never be pulled in unless a `.vue` file is actually parsed.
  const req = createRequire(import.meta.url);
  return req('@vue/compiler-sfc') as CompilerSfcModule;
}

/**
 * Load `@vue/compiler-sfc` lazily. Returns null (memoized) when the optional peer is not installed or
 * fails to load — the frontend then reports `canParse: false` and parses as a passthrough. NEVER throws.
 */
export function loadCompilerSfc(): CompilerSfcModule | null {
  if (cached !== undefined) return cached;
  try {
    cached = (loaderOverride ?? defaultLoad)();
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * TEST-ONLY seam: override (or restore, with null) how `@vue/compiler-sfc` is loaded, resetting the
 * memoized module. Lets the test suite simulate a missing optional peer without touching the module
 * graph. Not part of the public contract.
 */
export function __setCompilerSfcLoaderForTests(loader: (() => CompilerSfcModule) | null): void {
  loaderOverride = loader;
  cached = undefined;
}
