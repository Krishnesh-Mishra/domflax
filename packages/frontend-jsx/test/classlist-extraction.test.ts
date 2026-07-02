import { describe, it, expect } from 'vitest';

import type {
  BackendContext,
  ClassSegment,
  EditPlan,
  IRDocument,
  IRElement,
  PatternName,
  SyntheticClass,
  SyntheticSink,
} from '@domflax/core';
import { createNullResolver, elementIds, getElement } from '@domflax/core';
import { normalizer } from '@domflax/pattern-kit';

import { createJsxBackend, createJsxFrontend } from '../src/index';

/* ───────────────────────── harness ───────────────────────── */

function parse(code: string, config: Record<string, unknown> = {}): IRDocument {
  const { doc } = createJsxFrontend().parse(code, {
    id: 'App.tsx',
    kind: 'tsx',
    resolver: createNullResolver(),
    normalizer,
    config,
    onDiagnostic: () => {},
  });
  return doc;
}

function printDoc(doc: IRDocument): string {
  const sink: SyntheticSink = { register: (s: SyntheticClass) => s.className, drain: () => [] };
  const plan: EditPlan = { moduleId: 'App.tsx', ops: [], provenance: new Map<number, PatternName>() };
  const ctx: BackendContext = {
    normalizer,
    resolver: createNullResolver(),
    sink,
    eol: '\n',
    onDiagnostic: () => {},
  };
  return createJsxBackend().print(doc, plan, ctx).code;
}

function firstElement(doc: IRDocument, tag: string): IRElement {
  for (const id of elementIds(doc)) {
    const el = getElement(doc, id);
    if (el && el.tag === tag) return el;
  }
  throw new Error(`no <${tag}> in doc`);
}

function sliceSpan(doc: IRDocument, seg: ClassSegment): string {
  const sf = [...doc.sources.values()][0]!;
  return seg.span ? sf.text.slice(seg.span.start, seg.span.end) : '';
}

function staticTokens(seg: ClassSegment): string[] {
  return seg.kind === 'static' ? seg.tokens.map((t) => t.value) : [];
}

/** Replace the tokens of the static segment at `index` (what segment-compress does). */
function rewriteSegment(el: IRElement, index: number, tokens: readonly string[]): void {
  const segments = el.classes.segments.map((seg, i) =>
    i === index && seg.kind === 'static'
      ? { ...seg, tokens: tokens.map((value) => ({ value })) }
      : seg,
  );
  el.classes = { ...el.classes, segments };
}

/* ───────────────────────── cn()/clsx() call extraction ───────────────────────── */

describe('jsx frontend — cn()/clsx() static extraction', () => {
  const CN = `const A = () => (
  <div className={cn("px-4 py-4 h-10 w-10", active && "bg-red-500", props.cls)}>x</div>
);
`;

  it('lowers string-literal args to STATIC segments with precise contents spans', () => {
    const doc = parse(CN);
    const div = firstElement(doc, 'div');
    const cl = div.classes;

    expect(cl.form).toBe('call');
    expect(cl.hasDynamic).toBe(true); // full class set unknown → flatten stays blocked
    expect(cl.opaque).toBe(false);
    expect(cl.rewritable).toBe(true);
    expect(cl.wholeExpr).toBeDefined();

    expect(cl.segments).toHaveLength(3);
    const [s0, s1, s2] = cl.segments;
    expect(s0!.kind).toBe('static');
    expect(staticTokens(s0!)).toEqual(['px-4', 'py-4', 'h-10', 'w-10']);
    // The span is the string's CONTENTS — quotes excluded — so a splice never eats a quote.
    expect(sliceSpan(doc, s0!)).toBe('px-4 py-4 h-10 w-10');
    expect(s1!.kind).toBe('dynamic');
    expect(s2!.kind).toBe('dynamic');
  });

  it('recognizes clsx / classNames / classnames / twMerge / twJoin', () => {
    for (const callee of ['clsx', 'classNames', 'classnames', 'twMerge', 'twJoin']) {
      const doc = parse(`const A = () => <div className={${callee}("px-2", x)}>x</div>;`);
      const cl = firstElement(doc, 'div').classes;
      expect(cl.opaque).toBe(false);
      expect(cl.rewritable).toBe(true);
      expect(staticTokens(cl.segments[0]!)).toEqual(['px-2']);
    }
  });

  it('an UNKNOWN wrapper fn (myCn) and cva stay fully opaque', () => {
    for (const callee of ['myCn', 'cva']) {
      const doc = parse(`const A = () => <div className={${callee}("px-2", x)}>x</div>;`);
      const cl = firstElement(doc, 'div').classes;
      expect(cl.hasDynamic).toBe(true);
      expect(cl.opaque).toBe(true);
      expect(cl.rewritable).toBe(false);
      expect(cl.segments).toHaveLength(1);
      expect(cl.segments[0]!.kind).toBe('dynamic');
    }
  });

  it('the callee set is configurable via frontend config `classCallees`', () => {
    const code = `const A = () => <div className={myCn("px-2", x)}>x</div>;`;
    const doc = parse(code, { classCallees: ['myCn'] });
    const cl = firstElement(doc, 'div').classes;
    expect(cl.rewritable).toBe(true);
    expect(staticTokens(cl.segments[0]!)).toEqual(['px-2']);
    // … and the default set is replaced, not extended.
    const doc2 = parse(`const A = () => <div className={cn("px-2", x)}>x</div>;`, {
      classCallees: ['myCn'],
    });
    expect(firstElement(doc2, 'div').classes.opaque).toBe(true);
  });

  it('a string literal with escape sequences is NOT splice-safe → dynamic', () => {
    // "a\tb" raw bytes differ from the cooked value; the only candidate is unsafe → fully opaque.
    const doc = parse(`const A = () => <div className={cn("a\\tb", x)}>x</div>;`);
    expect(firstElement(doc, 'div').classes.opaque).toBe(true);
  });

  it('a call with NO static string argument stays fully opaque', () => {
    const doc = parse(`const A = () => <div className={cn(x, y && z)}>x</div>;`);
    expect(firstElement(doc, 'div').classes.opaque).toBe(true);
  });
});

/* ───────────────────────── template-literal extraction ───────────────────────── */

describe('jsx frontend — template-literal static extraction', () => {
  it('lowers quasis to STATIC segments and ${expr} holes to DYNAMIC segments', () => {
    const doc = parse('const A = () => <div className={`px-4 py-4 ${x} mt-2 mb-2`}>x</div>;');
    const cl = firstElement(doc, 'div').classes;

    expect(cl.form).toBe('template-literal');
    expect(cl.hasDynamic).toBe(true);
    expect(cl.opaque).toBe(false);
    expect(cl.rewritable).toBe(true);

    expect(cl.segments).toHaveLength(3);
    expect(staticTokens(cl.segments[0]!)).toEqual(['px-4', 'py-4']);
    expect(sliceSpan(doc, cl.segments[0]!)).toBe('px-4 py-4 ');
    expect(cl.segments[1]!.kind).toBe('dynamic');
    expect(staticTokens(cl.segments[2]!)).toEqual(['mt-2', 'mb-2']);
    expect(sliceSpan(doc, cl.segments[2]!)).toBe(' mt-2 mb-2');
  });

  it('a quasi with a PARTIAL token at a ${} boundary is untouchable (dynamic)', () => {
    // `px-${n} mt-2`: "px-" concatenates with n at runtime — that chunk must never be rewritten.
    const doc = parse('const A = () => <div className={`px-${n} mt-2`}>x</div>;');
    const cl = firstElement(doc, 'div').classes;
    expect(cl.rewritable).toBe(true);
    expect(cl.segments[0]!.kind).toBe('dynamic'); // the "px-" chunk
    expect(staticTokens(cl.segments[2]!)).toEqual(['mt-2']); // the safe trailing chunk
  });

  it('a template with NO safe static chunk stays fully opaque', () => {
    const doc = parse('const A = () => <div className={`px-${n}`}>x</div>;');
    expect(firstElement(doc, 'div').classes.opaque).toBe(true);
  });
});

/* ───────────────────────── surgical per-segment printing ───────────────────────── */

describe('jsx backend — surgical static-segment splicing', () => {
  it('round-trips byte-for-byte when no segment was rewritten', () => {
    const src = `const A = () => (
  <div className={cn("px-4 py-4", active && "bg-red-500", props.cls)}>x</div>
);
`;
    expect(printDoc(parse(src))).toBe(src);
  });

  it('splices ONLY the rewritten cn() string argument; dynamic args stay byte-identical', () => {
    const src = `const A = () => (
  <div className={cn("px-4 py-4 h-10 w-10", active && "bg-red-500", props.cls)}>x</div>
);
`;
    const doc = parse(src);
    rewriteSegment(firstElement(doc, 'div'), 0, ['p-4', 'size-10']);
    expect(printDoc(doc)).toBe(`const A = () => (
  <div className={cn("p-4 size-10", active && "bg-red-500", props.cls)}>x</div>
);
`);
  });

  it('splices template chunks independently, PRESERVING boundary whitespace around \${expr}', () => {
    const src = 'const A = () => <div className={`px-4 py-4 ${x} mt-2 mb-2`}>x</div>;\n';
    const doc = parse(src);
    const div = firstElement(doc, 'div');
    rewriteSegment(div, 0, ['p-4']);
    rewriteSegment(div, 2, ['my-2']);
    expect(printDoc(doc)).toBe('const A = () => <div className={`p-4 ${x} my-2`}>x</div>;\n');
  });

  it('re-parses its own spliced output to the same segment model (idempotence)', () => {
    const src = `const A = () => <div className={cn("px-4 py-4", x)}>x</div>;\n`;
    const doc = parse(src);
    rewriteSegment(firstElement(doc, 'div'), 0, ['p-4']);
    const out = printDoc(doc);
    expect(out).toBe(`const A = () => <div className={cn("p-4", x)}>x</div>;\n`);
    // Second round-trip with no rewrite is byte-stable.
    expect(printDoc(parse(out))).toBe(out);
  });
});
