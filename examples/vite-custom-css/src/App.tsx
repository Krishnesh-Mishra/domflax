import './styles.css';

/**
 * Two demonstrations of the domflax custom-CSS provider:
 *
 *  1. FLATTEN case  — the `.center` wrapper exists only to flex-center its single
 *     child (`.card`). domflax recognizes the centering signature from styles.css
 *     and can collapse the wrapper, pushing `place-self:center` down onto the card.
 *     Fewer DOM nodes, identical rendered UI.
 *
 *  2. SELECTOR-SAFETY case — the `.item` wrapper looks like removable noise (a
 *     do-nothing <div> around a single <h3>), BUT the rule `.list > .item h3`
 *     in styles.css depends on it. Removing `.item` would break that selector and
 *     change the heading's color, so the wrapper MUST be preserved.
 */
export default function App() {
  return (
    <main className="card">
      <h1>domflax — custom-CSS provider</h1>
      <p className="muted">
        Open the built/served HTML and compare the DOM with the source JSX below.
      </p>

      {/* CASE 1 — flatten candidate.
          `.center` paints nothing; it only centers its single child. domflax can
          drop this wrapper and grant the card `place-self:center` instead. */}
      <div className="center">
        <div className="card">
          <h2>1. Flattened centering wrapper</h2>
          <p className="muted">
            The surrounding <code>.center</code> div is pure layout noise — it can be
            removed without changing a pixel.
          </p>
        </div>
      </div>

      {/* CASE 2 — preserved wrapper (selector safety).
          `.item` is a do-nothing wrapper, but `.list > .item h3` colors the heading
          crimson ONLY while `.item` sits directly inside `.list`. Flattening `.item`
          would silently break that rule, so domflax keeps the wrapper. */}
      <div className="list">
        <div className="item">
          <h3>2. Preserved wrapper (crimson via .list &gt; .item h3)</h3>
        </div>
      </div>
    </main>
  );
}
