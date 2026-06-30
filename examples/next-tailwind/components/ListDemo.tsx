// ListDemo — a `.map(...)` list where every row has an inert wrapper and a verbose
// class set.
//
// JSX written inside `.map(...)` callbacks IS optimized in domflax 0.1.1: the inert
// per-row wrapper is flattened and the row's verbose classes are compressed
// (`px-4 py-4` → `p-4`). The dynamic `{item.*}` expressions, the stable React `key`,
// and the list data are all treated as opaque and preserved.
interface Row {
  readonly id: number;
  readonly label: string;
  readonly value: string;
}

const ROWS: readonly Row[] = [
  { id: 1, label: 'Nodes before', value: '128' },
  { id: 2, label: 'Nodes after', value: '94' },
  { id: 3, label: 'Class tokens saved', value: '37' },
];

export function ListDemo() {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold">3. List — mapped rows (optimized in 0.1.1)</h2>
      <p className="mt-1 text-sm text-slate-500">
        JSX inside <code>.map(...)</code> is optimized: the inert row wrapper is flattened and
        <code className="ml-1">px-4 py-4</code> → <code>p-4</code>. Dynamic <code>{'{item}'}</code>
        values and stable keys are preserved.
      </p>

      <ul className="mt-4 divide-y divide-slate-100">
        {ROWS.map((item) => (
          <li key={item.id}>
            {/* FLATTEN: this inert wrapper <div> is removed. COMPRESS: px-4 py-4 → p-4. */}
            <div>
              <div className="px-4 py-4 flex items-center justify-between">
                <span className="text-sm text-slate-600">{item.label}</span>
                <span className="font-mono text-sm font-semibold text-slate-900">{item.value}</span>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
