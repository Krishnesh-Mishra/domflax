// FlattenDemo — markup that domflax's *flatten* pass can collapse.
//
// Each block below is a redundant wrapper around a single child:
//   1. A flex-centering wrapper (`flex justify-center items-center`) whose only job is to center
//      one child — domflax can fold the centering onto the child and drop the wrapper.
//   2. Nested redundant `<div>`s that add no layout of their own — domflax can unwrap them.
//
// The rendered UI is identical before and after; only the DOM node count goes down.
export function FlattenDemo() {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold">1. Flatten — redundant wrappers</h2>
      <p className="mt-1 text-sm text-slate-500">
        Flex-centering wrappers and nested no-op <code>&lt;div&gt;</code>s collapse into their child.
      </p>

      {/* Flex-centering wrapper around a single child. */}
      <div className="mt-4 flex justify-center items-center">
        <div className="h-10 w-10 rounded bg-indigo-200" />
      </div>

      {/* Nested redundant wrappers around a single child. */}
      <div>
        <div>
          <div className="mt-4 text-center text-sm text-slate-600">
            Centered, then wrapped three levels deep for no reason.
          </div>
        </div>
      </div>
    </section>
  );
}
