// CompressDemo — verbose class sets that domflax's *compress* pass can shrink.
//
// domflax matches on the *computed* styles, not the raw class strings, so equivalent
// class sets collapse to their shortest Tailwind form:
//   • `px-4 py-4`                      → `p-4`
//   • `w-8 h-8`                        → `size-8`
//   • `h-10 w-10`                      → `size-10`   (even with a dynamic `{expr}` child)
//   • `top-0 right-0 bottom-0 left-0`  → `inset-0`
//
// Same computed styles, fewer / shorter classes.
export function CompressDemo() {
  const count = 42;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold">2. Compress — verbose class sets</h2>
      <p className="mt-1 text-sm text-slate-500">
        Equivalent utilities collapse to their shortest form (computed-style aware).
      </p>

      {/* px-4 py-4 is equivalent to p-4. */}
      <div className="mt-4 px-4 py-4 rounded bg-emerald-100 text-sm text-emerald-800">
        Padded with <code>px-4 py-4</code>.
      </div>

      <div className="mt-4 flex items-center gap-3">
        {/* w-8 h-8 is a fixed square. */}
        <span className="w-8 h-8 rounded-full bg-rose-300" />
        {/* h-10 w-10 → size-10 even though this element has a dynamic {count} child. */}
        <span className="h-10 w-10 inline-flex items-center justify-center rounded-full bg-rose-200 text-sm font-semibold text-rose-900">
          {count}
        </span>
        <span className="text-sm text-slate-600">
          A <code>w-8 h-8</code> swatch and a dynamic <code>h-10 w-10</code> counter.
        </span>
      </div>

      {/* A relatively-positioned box with an inset-0 overlay (top/right/bottom/left all 0). */}
      <div className="relative mt-4 h-16 overflow-hidden rounded bg-slate-100">
        <div className="absolute top-0 right-0 bottom-0 left-0 flex items-center justify-center text-sm text-slate-500">
          Overlay pinned with <code className="ml-1">top/right/bottom/left-0</code>.
        </div>
      </div>
    </section>
  );
}
