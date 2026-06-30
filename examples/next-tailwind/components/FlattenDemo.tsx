// FlattenDemo — markup that domflax's *flatten* pass can collapse, plus the case it
// deliberately leaves alone.
//
// domflax 0.1.1 only flattens INERT wrappers — elements that establish no layout
// context and paint nothing:
//   1. Nested empty, style-less `<div>`s around a single child → unwrapped.
//   2. A single-child `display:contents` wrapper → dropped, its child hoisted.
//
// It does NOT flatten flex/grid CENTERING wrappers: such a wrapper establishes its
// child's layout context, so removing it can't be statically proven render-identical.
// domflax conservatively PRESERVES it (see the Roadmap) — it only *compresses* the
// child (`h-10 w-10` → `size-10`). There is no `place-self-center` in the output.
//
// The rendered UI is identical before and after; only the DOM node count goes down.
export function FlattenDemo() {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold">1. Flatten — inert wrappers</h2>
      <p className="mt-1 text-sm text-slate-500">
        Wrappers that paint nothing and establish no layout context collapse into their child.
      </p>

      {/* FLATTEN: two nested no-op <div>s around a single child — both removed. */}
      <div>
        <div>
          <div className="mt-4 px-4 py-4 rounded bg-indigo-100 text-sm text-indigo-900">
            Wrapped three levels deep for no reason — the two outer no-op divs are dropped.
          </div>
        </div>
      </div>

      {/* FLATTEN: a single-child display:contents wrapper establishes no box and
          paints nothing, so domflax drops it and hoists the paragraph. */}
      <div className="contents">
        <p className="mt-4 text-sm text-slate-600">Hoisted out of a display:contents wrapper.</p>
      </div>

      {/* PRESERVED: a flex-centering wrapper establishes its child's layout context,
          so it is NOT flattened (conservative; see Roadmap). The child is only
          compressed: h-10 w-10 → size-10. */}
      <div className="mt-4 flex justify-center items-center">
        <div className="h-10 w-10 rounded bg-indigo-200" />
      </div>
    </section>
  );
}
