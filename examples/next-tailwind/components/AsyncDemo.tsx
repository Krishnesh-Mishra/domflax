// AsyncDemo — a Server Component that performs an async "data fetch".
//
// This is the control case: domflax only rewrites the STATIC shape of markup. The async function,
// the awaited data, and the `{stat.*}` expressions are dynamic, so domflax treats them as opaque and
// leaves them untouched — the data still renders exactly as fetched.
interface Stat {
  readonly id: string;
  readonly name: string;
  readonly amount: number;
}

// Stand-in for a real `await fetch(...)`; returns fake data after a tick.
async function getStats(): Promise<readonly Stat[]> {
  await new Promise((resolve) => setTimeout(resolve, 10));
  return [
    { id: 'a', name: 'Builds optimized', amount: 1280 },
    { id: 'b', name: 'Wrappers removed', amount: 412 },
    { id: 'c', name: 'Bytes shaved', amount: 9810 },
  ];
}

export async function AsyncDemo() {
  const stats = await getStats();

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold">4. Async Server Component — preserved</h2>
      <p className="mt-1 text-sm text-slate-500">
        Data is fetched in an <code>async</code> Server Component. domflax leaves dynamic / awaited
        content untouched.
      </p>

      <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {stats.map((stat) => (
          <div key={stat.id} className="rounded-lg bg-slate-50 p-4">
            <dt className="text-xs uppercase tracking-wide text-slate-500">{stat.name}</dt>
            <dd className="mt-1 text-2xl font-bold text-slate-900">
              {stat.amount.toLocaleString()}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
