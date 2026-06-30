import { describe, it, expect } from 'vitest';

import type {
  BackendContext,
  ClassList,
  EditPlan,
  IRDocument,
  IRElement,
  IRFragment,
  IRNodeId,
  PatternName,
  RewriteOp,
  SyntheticClass,
  SyntheticSink,
} from '@domflax/core';
import { applyOps, createNullResolver, elementIds, getElement } from '@domflax/core';
import { normalizer } from '@domflax/pattern-kit';

import { createJsxBackend, createJsxFrontend } from '../src/index';

/* ───────────────────────── fixtures ───────────────────────── */

// A wrapper <div> with a SINGLE element child (the <button>), which itself nests two leaf
// elements — exercising every opacity barrier the frontend must record:
//   button → hasEventHandlers (onClick), hasRef (ref=), hasDynamicChildren ({label})
//   span   → hasDangerousHtml (dangerouslySetInnerHTML=), selfClosing
//   input  → dynamic className ({cls} ⇒ classes.hasDynamic/opaque), hasSpreadAttrs ({...rest})
const CODE = `const App = () => (
  <div className="wrapper">
    <button className="btn primary" onClick={onClick} ref={btnRef} data-id="x">
      Hello {label}
      <span dangerouslySetInnerHTML={{ __html: raw }} />
      <input className={cls} {...rest} />
    </button>
  </div>
);
`;

function parse(code: string): IRDocument {
  const fe = createJsxFrontend();
  const { doc } = fe.parse(code, {
    id: 'App.tsx',
    kind: 'tsx',
    resolver: createNullResolver(),
    normalizer,
    config: {},
    onDiagnostic: () => {},
  });
  return doc;
}

function elementChildren(doc: IRDocument, el: IRElement): IRElement[] {
  const out: IRElement[] = [];
  for (const id of el.children) {
    const n = doc.nodes.get(id);
    if (n && n.kind === 'element') out.push(n);
  }
  return out;
}

function rootElements(doc: IRDocument): IRElement[] {
  const frag = doc.nodes.get(doc.root) as IRFragment;
  const out: IRElement[] = [];
  for (const id of frag.children) {
    const n = doc.nodes.get(id);
    if (n && n.kind === 'element') out.push(n);
  }
  return out;
}

function printDoc(doc: IRDocument): string {
  const sink: SyntheticSink = { register: (s: SyntheticClass) => s.className, drain: () => [] };
  const plan: EditPlan = {
    moduleId: 'App.tsx',
    ops: [],
    provenance: new Map<number, PatternName>(),
  };
  const ctx: BackendContext = {
    normalizer,
    resolver: createNullResolver(),
    sink,
    eol: '\n',
    onDiagnostic: () => {},
  };
  return createJsxBackend().print(doc, plan, ctx).code;
}

/* ───────────────────────── tests ───────────────────────── */

describe('jsx frontend → IR', () => {
  it('lowers a single top-level JSX island under the root fragment', () => {
    const doc = parse(CODE);
    const roots = rootElements(doc);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.tag).toBe('div');
    expect(roots[0]!.namespace).toBe('html');
    expect(roots[0]!.isComponent).toBe(false);
  });

  it('the wrapper div has exactly one element child (the button)', () => {
    const doc = parse(CODE);
    const div = rootElements(doc)[0]!;
    const kids = elementChildren(doc, div);
    expect(kids).toHaveLength(1);
    expect(kids[0]!.tag).toBe('button');

    // static className split into tokens
    expect(div.classes.hasDynamic).toBe(false);
    expect(div.classes.segments[0]).toMatchObject({ kind: 'static' });
    const divTokens =
      div.classes.segments[0]!.kind === 'static' ? div.classes.segments[0]!.tokens : [];
    expect(divTokens.map((t) => t.value)).toEqual(['wrapper']);
  });

  it('records opacity-barrier flags on the button', () => {
    const doc = parse(CODE);
    const button = elementChildren(doc, rootElements(doc)[0]!)[0]!;
    expect(button.meta.hasEventHandlers).toBe(true); // onClick={…}
    expect(button.meta.hasRef).toBe(true); // ref={…}
    expect(button.meta.hasDynamicChildren).toBe(true); // {label}
    expect(button.meta.hasSpreadAttrs).toBe(false);

    const tokens =
      button.classes.segments[0]!.kind === 'static' ? button.classes.segments[0]!.tokens : [];
    expect(tokens.map((t) => t.value)).toEqual(['btn', 'primary']);

    // data-id static attr survives; className is NOT in the attr map.
    expect(button.attrs.entries.has('className')).toBe(false);
    expect(button.attrs.entries.get('data-id')).toMatchObject({ kind: 'static', value: 'x' });
    // onClick / ref are dynamic ExprRefs.
    expect(button.attrs.entries.get('onClick')!.kind).toBe('dynamic');
    expect(button.attrs.entries.get('ref')!.kind).toBe('dynamic');
  });

  it('records dangerous-html, dynamic-class, and spread flags on the leaves', () => {
    const doc = parse(CODE);
    const button = elementChildren(doc, rootElements(doc)[0]!)[0]!;
    const leaves = elementChildren(doc, button);
    const span = leaves.find((e) => e.tag === 'span')!;
    const input = leaves.find((e) => e.tag === 'input')!;

    expect(span.meta.hasDangerousHtml).toBe(true);
    expect(span.selfClosing).toBe(true);

    expect(input.classes.hasDynamic).toBe(true);
    expect(input.classes.opaque).toBe(true);
    expect(input.classes.rewritable).toBe(false);
    expect(input.classes.segments[0]!.kind).toBe('dynamic');
    expect(input.meta.hasSpreadAttrs).toBe(true);
    expect(input.selfClosing).toBe(true);
  });

  it('keeps all dynamic JS in the ExprRegistry (out of the structural IR)', () => {
    const doc = parse(CODE);
    const button = elementChildren(doc, rootElements(doc)[0]!)[0]!;
    const onClick = button.attrs.entries.get('onClick')!;
    expect(onClick.kind).toBe('dynamic');
    if (onClick.kind === 'dynamic') {
      expect(doc.exprs.get(onClick.expr)).toBeDefined();
      expect(doc.exprs.get(onClick.expr)!.kind).toBe('identifier');
    }
  });
});

describe('jsx backend ← IR (re-print)', () => {
  it('re-prints valid, equivalent JSX', () => {
    const doc = parse(CODE);
    const out = printDoc(doc);

    expect(out).toContain('<div className="wrapper">');
    expect(out).toContain('<button className="btn primary"');
    expect(out).toContain('onClick={onClick}');
    expect(out).toContain('ref={btnRef}');
    expect(out).toContain('data-id="x"');
    expect(out).toContain('Hello {label}');
    expect(out).toContain('dangerouslySetInnerHTML=');
    expect(out).toContain('className={cls}');
    expect(out).toContain('{...rest}');
    expect(out).toContain('</button>');
    expect(out).toContain('</div>');
  });

  it('round-trips: re-printed output re-parses to an equivalent IR shape', () => {
    const doc = parse(CODE);
    const out = printDoc(doc);

    // The re-printed source is itself valid JSX the frontend can parse again.
    const doc2 = parse(out);

    // Same element population, same single-child wrapper shape.
    expect(elementIds(doc2).length).toBe(elementIds(doc).length);
    const div2 = rootElements(doc2)[0]!;
    expect(div2.tag).toBe('div');
    const kids2 = elementChildren(doc2, div2);
    expect(kids2).toHaveLength(1);
    expect(getElement(doc2, kids2[0]!.id)!.tag).toBe('button');
  });
});

/* ───────────────────────── surgical full-module codegen ───────────────────────── */

// A COMPLETE module — imports, an `export default function`, hooks, a `return (…)`, and a `{title}`
// hole — so the backend's job is to round-trip the WHOLE file, not just the JSX subtree. This is the
// regression that the bare-fragment fixtures above could never have caught.
const MODULE = `import React from 'react';

export default function Card({ title }) {
  const ref = React.useRef(null);
  return (
    <div className="wrapper-outer" ref={ref}>
      <div className="px-4 py-4 bg-white">{title}</div>
    </div>
  );
}
`;

/** Replace an element's static class tokens, preserving its original value span (what reverse-emit does). */
function setStaticTokens(el: IRElement, tokens: readonly string[]): void {
  const next: ClassList = {
    form: 'string-literal',
    segments: [{ kind: 'static', span: el.classes.segments[0]?.span, tokens: tokens.map((value) => ({ value })) }],
    valueSpan: el.classes.valueSpan,
    attrSpan: el.classes.attrSpan,
    hasDynamic: false,
    opaque: false,
    rewritable: true,
  };
  el.classes = next;
  el.meta.touched = true;
}

describe('jsx backend ← IR (surgical full-module codegen)', () => {
  it('round-trips a FULL module verbatim when nothing was optimized', () => {
    const doc = parse(MODULE);
    const out = printDoc(doc);
    // The surrounding module — NOT just the JSX subtree — survives byte-for-byte.
    expect(out).toBe(MODULE);
  });

  it('rewrites ONLY the changed className value, leaving all surrounding code intact', () => {
    const doc = parse(MODULE);
    // outer div → inner div (the one with px-4 py-4 bg-white)
    const innerDiv = elementChildren(doc, rootElements(doc)[0]!)[0]!;
    setStaticTokens(innerDiv, ['p-4', 'bg-white']);

    const out = printDoc(doc);

    // surrounding module survives …
    expect(out).toContain("import React from 'react';");
    expect(out).toContain('export default function Card({ title })');
    expect(out).toContain('const ref = React.useRef(null);');
    expect(out).toContain('return (');
    expect(out).toContain('{title}');
    expect(out).toContain('ref={ref}'); // dynamic attr on the outer div untouched
    expect(out).toContain('className="wrapper-outer"'); // outer class untouched

    // … and ONLY the inner class value changed.
    expect(out).toContain('className="p-4 bg-white"');
    expect(out).not.toContain('px-4');
    expect(out).not.toContain('py-4');
  });

  it('unwraps a wrapper by deleting only its tags — child subtree (and {title}) preserved verbatim', () => {
    const doc = parse(MODULE);
    const outerId: IRNodeId = rootElements(doc)[0]!.id;
    const op: RewriteOp = {
      op: 'unwrap',
      target: outerId,
      origin: { pattern: 'test/unwrap', category: 'flatten/test', safety: 0 },
    };
    const { doc: out } = applyOps(doc, [op], { safetyCeiling: 3 });
    const printed = printDoc(out);

    // The whole module shell survives …
    expect(printed).toContain("import React from 'react';");
    expect(printed).toContain('export default function Card({ title })');
    expect(printed).toContain('return (');

    // … the wrapper's tags are gone (its className no longer appears) …
    expect(printed).not.toContain('wrapper-outer');

    // … and the surviving child + its {title} hole are preserved verbatim.
    expect(printed).toContain('<div className="px-4 py-4 bg-white">{title}</div>');

    // Re-printed output is itself valid JSX/TSX the frontend can re-parse.
    expect(() => parse(printed)).not.toThrow();
  });
});

/* ───────────────────────── JSX nested inside expression holes ───────────────────────── */

/** Every element id reachable from the root, as live IRElements. */
function allElements(doc: IRDocument): IRElement[] {
  return elementIds(doc).map((id) => getElement(doc, id)!);
}

function findByTag(doc: IRDocument, tag: string): IRElement[] {
  return allElements(doc).filter((e) => e.tag === tag);
}

function staticTokensOf(el: IRElement): string[] {
  const seg = el.classes.segments[0];
  return seg && seg.kind === 'static' ? seg.tokens.map((t) => t.value) : [];
}

function sourceOf(doc: IRDocument, el: IRElement): string {
  const sf = [...doc.sources.values()][0]!;
  return el.span ? sf.text.slice(el.span.start, el.span.end) : '';
}

// The confirmed regression fixture: JSX nested inside a `.map` callback — an empty `<div>` wrapper
// around a `<div className="px-4 py-4">` row, keyed on the `<li>`.
const MAP_MODULE = `export default function List({ items }) {
  return (
    <ul className="list">
      {items.map((f) => (
        <li key={f.id}>
          <div>
            <div className="px-4 py-4">{f.name}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}
`;

describe('jsx frontend → IR (JSX nested inside expression holes)', () => {
  it('lowers JSX inside a `.map` callback into visitable IR element nodes with real spans', () => {
    const doc = parse(MAP_MODULE);

    // The <li>/<div>/<div> nested in the map body are now real, reachable element nodes.
    const tags = allElements(doc).map((e) => e.tag);
    expect(tags).toContain('ul');
    expect(tags).toContain('li');
    expect(tags.filter((t) => t === 'div')).toHaveLength(2);

    const li = findByTag(doc, 'li')[0]!;
    // The <li> is reachable from the root and carries a TRUE source span (inside the map body).
    expect(elementIds(doc)).toContain(li.id);
    expect(li.span).not.toBeNull();
    expect(sourceOf(doc, li).startsWith('<li')).toBe(true);
    expect(sourceOf(doc, li)).toContain('key={f.id}');
    expect(li.meta.hasKey).toBe(true);
    expect(li.isComponent).toBe(false);

    // The inner row keeps its compressible static classes (so the compress pass can see them).
    const inner = findByTag(doc, 'div').find((d) => staticTokensOf(d).includes('px-4'))!;
    expect(staticTokensOf(inner)).toEqual(['px-4', 'py-4']);
    expect(sourceOf(doc, inner)).toBe('<div className="px-4 py-4">{f.name}</div>');

    // The `.map(...)` call itself is still preserved as an opaque dynamic child of <ul>.
    const ul = findByTag(doc, 'ul')[0]!;
    expect(ul.meta.hasDynamicChildren).toBe(true);
  });

  it('lowers JSX inside a `&&` logical expression', () => {
    const doc = parse(`const A = () => <div>{show && <span className="px-2 py-2">hi</span>}</div>;`);
    const span = findByTag(doc, 'span')[0];
    expect(span).toBeDefined();
    expect(staticTokensOf(span!)).toEqual(['px-2', 'py-2']);
    expect(elementIds(doc)).toContain(span!.id);
  });

  it('lowers BOTH branches of a ternary into element nodes', () => {
    const doc = parse(
      `const A = () => <div>{cond ? <a className="x">A</a> : <b className="y">B</b>}</div>;`,
    );
    expect(findByTag(doc, 'a')[0]).toBeDefined();
    expect(findByTag(doc, 'b')[0]).toBeDefined();
    expect(staticTokensOf(findByTag(doc, 'a')[0]!)).toEqual(['x']);
    expect(staticTokensOf(findByTag(doc, 'b')[0]!)).toEqual(['y']);
  });
});

describe('jsx backend ← IR (surgical edits inside a `.map` callback)', () => {
  it('round-trips a map row: unwrap the empty <div> + rewrite className, preserving key/{expr}', () => {
    const doc = parse(MAP_MODULE);

    // The empty wrapper <div> is the one whose only element child is the px-4 row.
    const innerRow = findByTag(doc, 'div').find((d) => staticTokensOf(d).includes('px-4'))!;
    const wrapperDiv = findByTag(doc, 'div').find((d) => staticTokensOf(d).length === 0)!;

    // 1) compress the row's class (px-4 py-4 → p-4), 2) flatten the empty wrapper <div>.
    const op: RewriteOp = {
      op: 'unwrap',
      target: wrapperDiv.id,
      origin: { pattern: 'test/unwrap', category: 'flatten/test', safety: 0 },
    };
    const { doc: out } = applyOps(doc, [op], { safetyCeiling: 3 });
    const survivingRow = getElement(out, innerRow.id)!;
    setStaticTokens(survivingRow, ['p-4']);

    const printed = printDoc(out);

    // The whole module shell + the `.map((f) => …)` scaffolding survive verbatim.
    expect(printed).toContain('export default function List({ items })');
    expect(printed).toContain('{items.map((f) => (');
    expect(printed).toContain('<ul className="list">');

    // The keyed <li> and the dynamic {f.name} hole are preserved verbatim.
    expect(printed).toContain('<li key={f.id}>');
    expect(printed).toContain('{f.name}');

    // The empty wrapper <div> tags are gone, and the row's className was rewritten in place.
    expect(printed).toContain('<div className="p-4">{f.name}</div>');
    expect(printed).not.toContain('px-4');
    expect(printed).not.toContain('py-4');

    // Output is still valid JSX/TSX the frontend can re-parse.
    expect(() => parse(printed)).not.toThrow();
  });

  it('KEY SAFETY: unwrapping a keyed wrapper transfers its key onto the surviving child', () => {
    // Here the KEYED element is itself the wrapper being unwrapped; its single child has no key.
    const KEY_MODULE = `export default function List({ items }) {
  return (
    <ul>
      {items.map((f) => (
        <li key={f.id}>
          <div className="row">{f.name}</div>
        </li>
      ))}
    </ul>
  );
}
`;
    const doc = parse(KEY_MODULE);
    const li = findByTag(doc, 'li')[0]!;
    const op: RewriteOp = {
      op: 'unwrap',
      target: li.id,
      origin: { pattern: 'test/unwrap', category: 'flatten/test', safety: 0 },
    };
    const { doc: out } = applyOps(doc, [op], { safetyCeiling: 3 });
    const printed = printDoc(out);

    // The <li> tags are gone, but its key was salvaged onto the surviving <div>.
    expect(printed).not.toContain('<li');
    expect(printed).toContain('<div key={f.id} className="row">{f.name}</div>');
    expect(() => parse(printed)).not.toThrow();
  });
});
