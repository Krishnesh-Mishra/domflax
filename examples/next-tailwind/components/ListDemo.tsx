// ListDemo — a `.map(...)` list where every row has a redundant wrapper.
//
// NOTE: JSX written inside `.map(...)` callbacks is NOT optimized in domflax v0.1.0 — list /
// expression optimization is a documented Stage-2 roadmap item. domflax v0.1.0 optimizes
// component-return JSX (see FlattenDemo / CompressDemo). These per-row wrappers therefore ship as
// authored; the dynamic `{item.*}` expressions, the stable `key`, and the list data are preserved.
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
      <h2 className="text-lg font-semibold">3. List — mapped rows (not optimized in v0.1.0)</h2>
      <p className="mt-1 text-sm text-slate-500">
        JSX inside <code>.map(...)</code> is not optimized in v0.1.0 (Stage-2 roadmap); these row
        wrappers ship as authored. The dynamic <code>{'{item}'}</code> values and stable keys are
        preserved.
      </p>

      <ul className="mt-4 divide-y divide-slate-100">
        {ROWS.map((item) => (
          <li key={item.id}>
            {/* Redundant flex wrapper around the row's content. */}
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm text-slate-600">{item.label}</span>
              </div>
              <span className="font-mono text-sm font-semibold text-slate-900">{item.value}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
