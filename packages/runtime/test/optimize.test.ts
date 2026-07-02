// @vitest-environment jsdom
/**
 * @domflax/runtime — transform rules.
 *
 * The runtime removes exactly two wrapper shapes (bare <div>/<span>, and
 * <div>/<span> whose only attribute is style="display:contents") and must
 * return the input string UNCHANGED for everything else — including anything
 * the parser auto-corrects or normalizes (round-trip faithfulness gate).
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { optimizeHtml, clearCache } from '../src/index';

beforeEach(() => {
  clearCache();
});

describe('inert wrapper removal', () => {
  it('removes a bare <div> wrapper around a single element child', () => {
    expect(optimizeHtml('<div><p>hi</p></div>')).toBe('<p>hi</p>');
  });

  it('removes a bare <span> wrapper around a single element child', () => {
    expect(optimizeHtml('<span><b>x</b></span>')).toBe('<b>x</b>');
  });

  it('removes nested bare wrappers bottom-up', () => {
    expect(optimizeHtml('<div><div><em>y</em></div></div>')).toBe('<em>y</em>');
  });

  it('removes a wrapper whose only attribute is style="display:contents"', () => {
    expect(optimizeHtml('<div style="display:contents"><p>hi</p></div>')).toBe('<p>hi</p>');
  });

  it('accepts whitespace and a trailing semicolon in display:contents', () => {
    expect(optimizeHtml('<span style=" display : CONTENTS ; "><i>z</i></span>')).toBe('<i>z</i>');
  });

  it('preserves text and structure inside the hoisted child', () => {
    expect(optimizeHtml('<div><p>hello <b>world</b>!</p></div>')).toBe('<p>hello <b>world</b>!</p>');
  });

  it('optimizes each top-level sibling independently', () => {
    expect(optimizeHtml('<div><p>a</p></div><ul><li>b</li></ul>')).toBe('<p>a</p><ul><li>b</li></ul>');
  });
});

describe('wrappers that must never be removed', () => {
  const unchanged = (html: string) => expect(optimizeHtml(html)).toBe(html);

  it('keeps a wrapper with a class', () => {
    unchanged('<div class="card"><p>hi</p></div>');
  });

  it('keeps a wrapper with an id', () => {
    unchanged('<div id="root"><p>hi</p></div>');
  });

  it('keeps a wrapper with a data attribute', () => {
    unchanged('<div data-x="1"><p>hi</p></div>');
  });

  it('keeps a wrapper whose style has more than display:contents', () => {
    unchanged('<div style="display:contents;color:red"><p>hi</p></div>');
  });

  it('keeps a wrapper whose style is a different declaration', () => {
    unchanged('<div style="display:flex"><p>hi</p></div>');
  });

  it('keeps a wrapper with a text sibling next to the element child', () => {
    unchanged('<div>text<p>hi</p></div>');
  });

  it('keeps a wrapper with a whitespace-only text sibling', () => {
    unchanged('<div> <p>hi</p></div>');
  });

  it('keeps a wrapper with multiple element children', () => {
    unchanged('<div><p>a</p><p>b</p></div>');
  });

  it('keeps a wrapper whose only child is text', () => {
    unchanged('<div>just text</div>');
  });

  it('never touches tags other than div/span', () => {
    unchanged('<section><p>hi</p></section>');
  });

  it('keeps a bare wrapper around a <script> and leaves its content intact', () => {
    unchanged('<div><script>if (1<2) { go() }</script></div>');
  });

  it('keeps a bare wrapper around an <svg> subtree', () => {
    unchanged('<div><svg viewBox="0 0 1 1"><rect width="1" height="1"></rect></svg></div>');
  });

  it('a <style> block anywhere freezes the whole fragment (selectors may depend on structure)', () => {
    // `div>p{color:red}` targets the very wrapper an unwrap would remove — with no CSS
    // awareness the only safe behavior is to change nothing when a <style> is present.
    unchanged('<style>div>p{color:red}</style><div><p>a</p></div>');
    unchanged('<div>x</div><style>div>p{color:red}</style><div><p>a</p></div>');
  });

  it('never descends into <pre>', () => {
    unchanged('<pre><div><b>keep me wrapped</b></div></pre>');
  });

  it('keeps a wrapper carrying an inline event handler', () => {
    unchanged('<div onclick="x()"><p>hi</p></div>');
  });
});

describe('conservative bail-outs', () => {
  it('returns text-only input unchanged', () => {
    expect(optimizeHtml('just some text')).toBe('just some text');
  });

  it('returns the empty string unchanged', () => {
    expect(optimizeHtml('')).toBe('');
  });

  it('returns malformed HTML (unclosed tag) unchanged, without throwing', () => {
    const malformed = '<div><p>unclosed';
    expect(() => optimizeHtml(malformed)).not.toThrow();
    expect(optimizeHtml(malformed)).toBe(malformed);
  });

  it('returns garbage input unchanged, without throwing', () => {
    const garbage = '<<<not <html> at >>> all';
    expect(() => optimizeHtml(garbage)).not.toThrow();
    expect(optimizeHtml(garbage)).toBe(garbage);
  });

  it('returns table fragments unchanged (parser would foster-parent them)', () => {
    const row = '<tr><td>cell</td></tr>';
    expect(optimizeHtml(row)).toBe(row);
  });

  it('returns input the parser normalizes (uppercase tags) unchanged', () => {
    const upper = '<DIV><P>hi</P></DIV>';
    expect(optimizeHtml(upper)).toBe(upper);
  });

  it('is deterministic across repeated calls', () => {
    const html = '<div><p>hi</p></div>';
    expect(optimizeHtml(html)).toBe(optimizeHtml(html));
  });
});
