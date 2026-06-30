/**
 * domflax demo surface (Vite + React + Tailwind).
 *
 * Written the verbose-but-natural way real Tailwind code is written, so you can
 * watch domflax shrink it at BUILD time (see vite.config.ts) without changing a
 * pixel. Two kinds of win are on display, and both are conservative / static-only:
 *
 *   • COMPRESS — verbose, equivalent class sets collapse to their shortest form
 *     (`px-4 py-4` → `p-4`, `mt-2 mb-2` → `my-2`, `h-10 w-10` → `size-10`). This
 *     happens even on an element with a dynamic `{expr}` child (see <Counter>) and
 *     even inside `.map(...)` list rows (see the feature list below).
 *   • FLATTEN (inert wrappers only) — wrappers that establish no layout context and
 *     paint nothing (`display:contents`, empty style-less `<div>`s) are removed and
 *     their children hoisted.
 *
 * What domflax 0.1.1 does NOT do: it does not flatten flex/grid CENTERING wrappers.
 * Such a wrapper establishes its child's layout context, so dropping it can't be
 * statically proven render-identical — domflax conservatively PRESERVES it (see the
 * `<App>` shell below; it is only compressed `w-full h-full` → `size-full`, never
 * removed). Recovering those safely is a Roadmap item.
 */

const features = [
  { id: 'compress', name: 'Compress', blurb: 'Collapse verbose class sets.' },
  { id: 'flatten', name: 'Flatten', blurb: 'Drop inert wrapper elements.' },
  { id: 'verify', name: 'Verify', blurb: 'Prove before/after render identically.' },
];

function Counter({ count }: { count: number }) {
  // COMPRESS + dynamic child: `h-10 w-10` → `size-10`, even though this element has
  // a dynamic `{count}` child. domflax treats the child as opaque and still
  // compresses the (static) class set around it.
  return (
    <span className="h-10 w-10 inline-flex items-center justify-center rounded-full bg-emerald-100 text-emerald-800">
      {count}
    </span>
  );
}

function Card() {
  return (
    // COMPRESS: `px-4 py-4` → `p-4`.
    <div className="relative px-4 py-4 rounded-2xl border border-slate-200 shadow-sm bg-white max-w-md">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900">domflax</h1>
        <Counter count={features.length} />
      </div>
      {/* COMPRESS (two axes at once): `px-4 py-4` → `p-4` and `mt-2 mb-2` → `my-2`. */}
      <p className="mt-2 mb-2 px-4 py-4 text-sm text-slate-600 bg-slate-50 rounded-lg">
        Compile-time DOM flattener and semantic CSS compressor — fewer DOM nodes,
        smaller class sets, identical rendered UI.
      </p>

      {/* FLATTEN: a single-child `display:contents` wrapper establishes no box and
          paints nothing, so domflax removes it and hoists the `<ul>`. */}
      <div className="contents">
        <ul className="mt-4 space-y-2">
          {features.map((f) => (
            // COMPRESS + FLATTEN inside `.map(...)`: list rows ARE optimized in
            // 0.1.1. The inert wrapper `<div>` below is removed and `px-4 py-4`
            // → `p-4` on the row. The stable React `key` and dynamic `{f.*}`
            // content are preserved.
            <li key={f.id}>
              <div>
                <div className="px-4 py-4 rounded-lg bg-slate-50">
                  <span className="font-medium text-slate-800">{f.name}</span>
                  <span className="ml-2 text-slate-500">{f.blurb}</span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default function App() {
  return (
    // PRESERVED: this flex-centering wrapper establishes its child's layout context,
    // so domflax does NOT flatten it — it only compresses `w-full h-full` →
    // `size-full`. Conservative by default; see the Roadmap.
    <div className="w-full h-full flex justify-center items-center bg-slate-100">
      <Card />
    </div>
  );
}
