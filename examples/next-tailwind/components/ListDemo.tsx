// ListDemo — a `.map(...)` list where every row has a redundant wrapper.
//
// Each row renders a redundant centering `<div>` around its content. domflax flattens the static
// wrapper shape inside the map callback while preserving the dynamic `{item.*}` expressions and the
// stable `key`. The list data itself is untouched.
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
      <h2 className="text-lg font-semibold">3. List — mapped rows with redundant wrappers</h2>
      <p className="mt-1 text-sm text-slate-500">
        Static row wrappers flatten; the dynamic <code>{'{item}'}</code> values and stable keys are
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
