/**
 * domflax demo surface.
 *
 * Everything below is written the "verbose but natural" way most React/Tailwind
 * code is written: a flex-centering wrapper around the real content, a couple of
 * nested wrappers that exist only to hold a single child, and classes that
 * domflax's compress patterns can shorten (`px-4 py-4` → `p-4`,
 * `top-0 right-0 bottom-0 left-0` → `inset-0`, …).
 *
 * domflax runs at BUILD time (see vite.config.ts). The source you read here is the
 * authored shape; the shipped DOM is the smaller, equivalent shape. Open the page
 * in devtools and count the nodes, or read `dist/` after `npm run build`.
 */

const features = [
  { id: 'flatten', name: 'Flatten', blurb: 'Remove redundant wrapper elements.' },
  { id: 'compress', name: 'Compress', blurb: 'Collapse verbose class sets into minimal equivalents.' },
  { id: 'verify', name: 'Verify', blurb: 'Prove before/after render identically.' },
];

function Badge() {
  // compress target: `top-0 right-0 bottom-0 left-0` is the long form of `inset-0`,
  // and `w-8 h-8` collapses to `size-8` once that compress pattern is available.
  return (
    <span className="absolute top-0 right-0 bottom-0 left-0 w-8 h-8 rounded-full bg-emerald-500/10" />
  );
}

function Card() {
  return (
    // compress target: `px-4 py-4` → `p-4`.
    <div className="relative px-4 py-4 rounded-2xl border border-slate-200 shadow-sm bg-white max-w-md">
      {/* a nested redundant wrapper: it has no styles and one child, pure structural noise. */}
      <div>
        <h1 className="text-xl font-semibold text-slate-900">domflax</h1>
        <p className="mt-2 text-sm text-slate-600">
          Compile-time DOM flattener and semantic CSS compressor — fewer DOM nodes,
          smaller class sets, identical rendered UI.
        </p>

        <ul className="mt-4 space-y-2">
          {features.map((f) => (
            // Per-row redundant wrapper around each list item: domflax flattens it
            // away while preserving the stable React `key` and the dynamic content.
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
    // flatten target: a full-size flex-centering wrapper whose only job is to
    // center its single child. domflax pushes `place-self:center` onto the child
    // and drops this wrapper.
    <div className="w-full h-full flex justify-center items-center bg-slate-100">
      {/* another redundant single-child wrapper stacked on top of the centering one. */}
      <div>
        <div className="relative">
          <Badge />
          <Card />
        </div>
      </div>
    </div>
  );
}
