/**
 * @domflax/frontend-jsx — className → {@link ClassList} lowering, incl. STATIC EXTRACTION for
 * mixed dynamic class expressions.
 *
 * Three shapes are lowered to segments with PRECISE splice spans:
 *
 *   • `className="a b"` / `className={"a b"}` — one fully-static list (unchanged behaviour);
 *   • `className={cn("px-4 py-4", cond && "x", props.cls)}` — a RECOGNIZED class-combiner call
 *     ({@link DEFAULT_CLASS_CALLEES}, overridable via frontend config `classCallees`): each plain
 *     string-literal argument becomes a STATIC segment whose span is the string's CONTENTS (quotes
 *     excluded); every other argument stays a DYNAMIC segment (opaque, byte-preserved);
 *   • `` className={`px-4 ${x} mt-2`} `` — an untagged template literal: each quasi chunk becomes a
 *     STATIC segment (span = the chunk's raw text), each `${expr}` a DYNAMIC segment.
 *
 * SAFETY — a chunk is only STATIC when its bytes are provably whole class tokens:
 *   • a string literal whose raw contents differ from its cooked value (escape sequences) is left
 *     dynamic (we splice bytes, so cooked-vs-raw must be identity);
 *   • a template quasi adjacent to a `${expr}` WITHOUT whitespace at the boundary carries a PARTIAL
 *     token (`` `px-${n}` ``) — the whole quasi is left dynamic (untouchable);
 *   • an unrecognized callee (`myCn(…)`), tagged template, or a recognized call with NO static
 *     string argument falls back to the fully-opaque single-dynamic-segment list.
 *
 * The resulting mixed list keeps `hasDynamic: true` (the full class set is unknown ⇒ the element
 * stays OPAQUE for flatten) but `opaque: false` + `rewritable: true` so the segment-local compress
 * (`@domflax/core` segment-compress) may shorten the static chunks in place.
 */

import type {
  CallExpression,
  Expression,
  JSXAttribute,
  Node as BabelNode,
  OptionalCallExpression,
  StringLiteral,
  TemplateLiteral,
} from '@babel/types';

import type { ClassList, ClassSegment, ClassToken, ExprRef, SourceSpan } from '@domflax/core';
import { emptyClassList } from '@domflax/core';

import { classFormOf } from './frontend-ast';

/**
 * Class-combiner callees recognized by default. `cva` is deliberately NOT included — its arguments
 * are variant CONFIG objects, not class strings to be merged in order.
 */
export const DEFAULT_CLASS_CALLEES: readonly string[] = [
  'cn',
  'clsx',
  'classNames',
  'classnames',
  'twMerge',
  'twJoin',
];

/** Parse-pass services the class-list builder needs (closures over the source + document). */
export interface ClassListHelpers {
  spanOf(node: BabelNode): SourceSpan | null;
  /** Raw source slice by absolute offsets. */
  slice(start: number, end: number): string;
  /** Intern any node as an opaque ExprRef (verbatim text payload). */
  internNode(node: BabelNode, spread: boolean): ExprRef;
  /** Recognized class-combiner callee names. */
  readonly callees: ReadonlySet<string>;
}

export function splitTokens(raw: string): ClassToken[] {
  return raw
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((value) => ({ value }) as ClassToken);
}

/* ───────────────────────── segment builders ───────────────────────── */

/**
 * A STATIC segment for a plain string-literal argument, spanning the string's CONTENTS (quotes
 * excluded). Returns null when the literal is not byte-splice-safe (escapes, missing positions).
 */
function staticStringSegment(lit: StringLiteral, h: ClassListHelpers): ClassSegment | null {
  const span = h.spanOf(lit);
  if (!span || span.end - span.start < 2) return null;
  const contents = h.slice(span.start + 1, span.end - 1);
  if (contents !== lit.value) return null; // escape sequences ⇒ raw bytes ≠ cooked value
  return {
    kind: 'static',
    span: { file: span.file, start: span.start + 1, end: span.end - 1 },
    tokens: splitTokens(lit.value),
  };
}

/** A DYNAMIC segment preserving `node` verbatim (never rewritten). */
function dynamicSegment(node: BabelNode, spread: boolean, h: ClassListHelpers): ClassSegment {
  return { kind: 'dynamic', span: h.spanOf(node) ?? undefined, expr: h.internNode(node, spread) };
}

/** True when the built segment is a static segment the backend could actually splice. */
function isRewritableStatic(seg: ClassSegment): boolean {
  return seg.kind === 'static' && seg.span != null && seg.tokens.length > 0;
}

/**
 * Lower a RECOGNIZED class-combiner call's arguments into segments (in argument order). Returns
 * null when no argument is a splice-safe static string — the caller falls back to fully opaque.
 */
function segmentsOfCall(
  call: CallExpression | OptionalCallExpression,
  h: ClassListHelpers,
): ClassSegment[] | null {
  const segs: ClassSegment[] = [];
  for (const arg of call.arguments) {
    if (arg.type === 'StringLiteral') {
      const seg = staticStringSegment(arg, h);
      segs.push(seg ?? dynamicSegment(arg, false, h));
      continue;
    }
    if (arg.type === 'ArgumentPlaceholder') return null; // exotic (partial application) → opaque
    segs.push(dynamicSegment(arg, arg.type === 'SpreadElement', h));
  }
  return segs.some(isRewritableStatic) ? segs : null;
}

/**
 * Lower an UNTAGGED template literal into interleaved quasi/expression segments. A quasi whose
 * bytes are not provably whole tokens (escape sequences, or a missing-whitespace boundary against a
 * neighbouring `${expr}`) becomes a DYNAMIC segment so it is never rewritten. Returns null when no
 * quasi is splice-safe.
 */
function segmentsOfTemplate(tpl: TemplateLiteral, h: ClassListHelpers): ClassSegment[] | null {
  const segs: ClassSegment[] = [];
  for (let i = 0; i < tpl.quasis.length; i += 1) {
    const quasi = tpl.quasis[i]!;
    const raw = quasi.value.raw;
    const cooked = quasi.value.cooked;
    const hasExprBefore = i > 0;
    const hasExprAfter = i < tpl.expressions.length;

    if (raw.trim().length === 0) {
      // Whitespace-only / empty chunk: nothing to rewrite, nothing to resolve. (An EMPTY chunk
      // between two `${}` holes means the holes concatenate — but both stay byte-identical.)
      segs.push({ kind: 'static', tokens: [] });
    } else {
      const span = h.spanOf(quasi);
      const spliceSafe =
        span != null &&
        cooked != null &&
        cooked === raw && // escape sequences ⇒ raw bytes ≠ runtime text
        (!hasExprBefore || /^\s/.test(raw)) && // `${x}px-4` ⇒ first token is a runtime concat
        (!hasExprAfter || /\s$/.test(raw)); // `px-${n}` ⇒ last token is a runtime concat
      segs.push(
        spliceSafe && span
          ? { kind: 'static', span, tokens: splitTokens(raw) }
          : dynamicSegment(quasi, false, h),
      );
    }

    if (hasExprAfter) segs.push(dynamicSegment(tpl.expressions[i]! as BabelNode, false, h));
  }
  return segs.some(isRewritableStatic) ? segs : null;
}

/* ───────────────────────── the className → ClassList lowering ───────────────────────── */

/** The recognized-call / template segmentation, or null when the expression stays fully opaque. */
function segmentedClassList(
  expr: Expression,
  attrSpan: SourceSpan | undefined,
  h: ClassListHelpers,
): ClassList | null {
  let segments: ClassSegment[] | null = null;

  if (
    (expr.type === 'CallExpression' || expr.type === 'OptionalCallExpression') &&
    expr.callee.type === 'Identifier' &&
    h.callees.has(expr.callee.name)
  ) {
    segments = segmentsOfCall(expr, h);
  } else if (expr.type === 'TemplateLiteral') {
    segments = segmentsOfTemplate(expr, h);
  }
  if (!segments) return null;

  return {
    form: classFormOf(expr),
    segments,
    valueSpan: h.spanOf(expr),
    attrSpan,
    // The full runtime class set is UNKNOWN (dynamic parts can add/override anything), so the
    // element must remain opaque for flatten — hasDynamic stays true even when every argument
    // happened to be static. Only the segment-local compress may touch the static chunks.
    hasDynamic: true,
    opaque: false,
    rewritable: true,
    wholeExpr: h.internNode(expr, false),
  };
}

/** Lower a `class`/`className` JSX attribute into its {@link ClassList}. */
export function buildClassList(attr: JSXAttribute, h: ClassListHelpers): ClassList {
  const attrSpan = h.spanOf(attr) ?? undefined;
  const v = attr.value;

  const staticList = (tokens: ClassToken[], valueSpan: SourceSpan | null): ClassList => {
    const seg: ClassSegment = { kind: 'static', span: valueSpan ?? undefined, tokens };
    return {
      form: 'string-literal',
      segments: [seg],
      valueSpan,
      attrSpan,
      hasDynamic: false,
      opaque: false,
      rewritable: true,
    };
  };

  if (v == null) return staticList([], null);

  if (v.type === 'StringLiteral') {
    return staticList(splitTokens(v.value), h.spanOf(v));
  }

  if (v.type === 'JSXExpressionContainer') {
    const expr = v.expression;
    // `className={"a b"}` is still a static string literal.
    if (expr.type === 'StringLiteral') {
      return staticList(splitTokens(expr.value), h.spanOf(expr));
    }
    if (expr.type === 'JSXEmptyExpression') return staticList([], null);

    // STATIC EXTRACTION: a recognized cn()/clsx()/… call or a template literal lowers to mixed
    // static/dynamic segments so its provably-static chunks can be compressed in place.
    const segmented = segmentedClassList(expr, attrSpan, h);
    if (segmented) return segmented;

    // Anything else (identifiers, unknown wrappers, conditionals, …) stays fully OPAQUE.
    const ref = h.internNode(expr, false);
    const valueSpan = h.spanOf(expr);
    const seg: ClassSegment = { kind: 'dynamic', span: valueSpan ?? undefined, expr: ref };
    return {
      form: classFormOf(expr),
      segments: [seg],
      valueSpan,
      attrSpan,
      hasDynamic: true,
      opaque: true,
      rewritable: false,
    };
  }

  return emptyClassList();
}
