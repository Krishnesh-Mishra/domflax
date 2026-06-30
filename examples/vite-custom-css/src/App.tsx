import './styles.css';

/**
 * Three demonstrations of the domflax custom-CSS provider (0.1.1). domflax parses
 * styles.css (forward: class → computed style; plus selector participation) and uses
 * it to decide which wrappers are safe to flatten and which must be preserved.
 *
 *   A. FLATTEN (inert wrappers) — a `display:contents` wrapper and an empty,
 *      style-less `<div>` paint nothing and establish no layout context, so domflax
 *      removes them and hoists their children. This also happens INSIDE `.map(...)`
 *      rows (list rows are optimized in 0.1.1); the dynamic `{expr}` content and the
 *      React `key`s are preserved.
 *
 *   B. SELECTOR-SAFETY (preserved) — the `.item` wrapper looks like removable noise
 *      (a do-nothing `<div>` around a single `<h3>`), BUT the rule `.list > .item h3`
 *      depends on it. Removing it would change the heading's color, so the wrapper
 *      MUST be — and is — preserved.
 *
 *   C. CENTERING (preserved) — the `.center` wrapper only flex-centers its child, but
 *      a flex wrapper establishes its child's layout context, so removing it cannot
 *      be statically proven render-identical. domflax conservatively KEEPS it (see
 *      the Roadmap). No `place-self-center` is emitted.
 */
const ITEMS = [
  { id: 1, name: 'flatten' },
  { id: 2, name: 'preserve' },
];

export default function App() {
  return (
    <main className="card">
      <h1>domflax — custom-CSS provider</h1>
      <p className="muted">
        Compare the built/served DOM with the source JSX below.
      </p>

      {/* CASE A — FLATTEN (inert wrappers).
          `.contents` is display:contents and the inner bare <div> is style-less;
          both are pure structural noise. domflax drops both and hoists the <p>. */}
      <div className="contents">
        <div>
          <p className="muted">Hoisted out of two inert wrappers.</p>
        </div>
      </div>

      {/* CASE A (cont.) — an inert wrapper INSIDE a `.map(...)` row is flattened too.
          The dynamic `{it.name}` text and the React `key` are preserved. */}
      <ul className="list-plain">
        {ITEMS.map((it) => (
          <li key={it.id}>
            <div>
              <span className="muted">{it.name}</span>
            </div>
          </li>
        ))}
      </ul>

      {/* CASE B — SELECTOR-SAFETY (preserved).
          `.list > .item h3` colors the heading crimson ONLY while `.item` sits
          directly inside `.list`. Flattening `.item` would silently break that rule,
          so domflax keeps the wrapper even though it paints nothing itself. */}
      <div className="list">
        <div className="item">
          <h3>Preserved wrapper (crimson via .list &gt; .item h3)</h3>
        </div>
      </div>

      {/* CASE C — CENTERING (preserved).
          `.center` only flex-centers its single child, but a flex wrapper establishes
          the child's layout context, so domflax conservatively keeps it. */}
      <div className="center">
        <div className="card">
          <h2>Preserved centering wrapper</h2>
          <p className="muted">
            The surrounding <code>.center</code> div is kept — a flex/grid centering
            wrapper can't be removed render-identically by a static pass.
          </p>
        </div>
      </div>
    </main>
  );
}
