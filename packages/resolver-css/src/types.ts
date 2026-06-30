import type { StyleCondition } from '@domflax/core';

/* ────────────────────────────────────────────────────────────────────────── *
 * Public input shapes
 * ────────────────────────────────────────────────────────────────────────── */

/** A single user-authored stylesheet handed to the resolver as raw text. */
export interface CssFile {
  /** Stable identifier (usually the absolute path) — also feeds the fingerprint. */
  readonly id: string;
  /** Verbatim stylesheet text. */
  readonly css: string;
}

/** Construction options for {@link CustomCSSResolver}. */
export interface CssResolverOptions {
  /** Overrides the auto-derived cache-busting fingerprint (e.g. a content hash from the caller). */
  readonly fingerprint?: string;
  /**
   * Additional stylesheet paths read synchronously from disk and appended to the raw `cssFiles`.
   * A path that cannot be read is a genuine input error and is rethrown with context.
   */
  readonly files?: readonly string[];
  /**
   * Directory to resolve `postcss` / `postcss-selector-parser` from. Defaults to `process.cwd()`,
   * falling back to this module's location. Resolution is independent of where domflax's bundle lives.
   */
  readonly projectRoot?: string;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Internal index shapes
 * ────────────────────────────────────────────────────────────────────────── */

export type RawDecl = readonly [property: string, value: string, important: boolean];

/** One simple-`.class` rule's contribution, tagged with its document position for cascade ordering. */
export interface RuleEntry {
  readonly order: number;
  readonly token: string;
  readonly condition: StyleCondition;
  readonly decls: readonly RawDecl[];
}

export interface MutableUsage {
  referenced: boolean;
  asSubject: boolean;
  asAncestor: boolean;
  asCompound: boolean;
  asSibling: boolean;
  asHasArgument: boolean;
  asStructural: boolean;
  /** Appears anywhere other than as the lone subject of a bare `.x {}` selector. */
  loadBearing: boolean;
}

export interface ReverseEntry {
  readonly token: string;
  /** `${conditionKey} ${property}` → canonical value, over this class's own resolution. */
  readonly keyed: ReadonlyMap<string, string>;
}
