import { describe, it, expect } from 'vitest';

import type {
  BackendContext,
  EditPlan,
  IRDocument,
  IRElement,
  IRFragment,
  PatternName,
  SyntheticClass,
  SyntheticSink,
} from '@domflax/core';
import { createNullResolver, elementIds, getElement } from '@domflax/core';
import { normalizer } from '@domflax/pattern-kit';

import { createJsxBackend, createJsxFrontend } from './index';

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
